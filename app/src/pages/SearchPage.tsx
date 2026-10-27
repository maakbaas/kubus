import { useEffect, useRef, useState, useMemo } from "react";
import { checklistItems } from "../domain/checklist";
import { htmlPlainText } from "../domain/fieldKinds";
import { useNavigate, useSearchParams } from "react-router";
import { ContainedList, ContainedListItem, InlineNotification, Tag } from "@carbon/react";
import { useStore } from "../app/store";
import type { Repository } from "../data/repository";
import { markdownExcerpt, type MarkdownExcerpt } from "../domain/markdownExcerpt";
import { editableField, isReferenceKind, itemLabel, labelField, type FieldDef, type Item, type Collection } from "../domain/model";
import { Highlight } from "../ui/Highlight";
import { CollectionIcon } from "../ui/collectionIcons";
import { MarkdownView } from "../ui/MarkdownView";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";

type Excerpt = { field: FieldDef; markdown: MarkdownExcerpt } | { field: FieldDef; text: string };

/** Plain text around the first match. */
function textExcerpt(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + query.length + 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/**
 * An excerpt for every field whose value contains the query, in field order: an AI field as its
 * output, an item or list-of-items field by the labels of the items it points to (`labels`).
 * The label field is skipped: it is already shown (highlighted) as the result's title.
 */
function excerpts(collection: Collection, item: Item, query: string, labels: Map<string, string>): Excerpt[] {
  const q = query.toLowerCase();
  const title = labelField(collection, item);
  return collection.fields.flatMap((def): Excerpt[] => {
    if (def.id === title?.id) return [];
    const field = editableField(def);
    const v = item.values[field.id];
    if (isReferenceKind(field.kind)) {
      const ids = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      const found = ids.flatMap((id) => labels.get(id) ?? []).filter((label) => label.toLowerCase().includes(q));
      if (found.length > 0) return [{ field, text: found.map((label) => textExcerpt(label, query)).join(", ") }];
    }
    if (field.kind === "markdown" && typeof v === "string" && v.toLowerCase().includes(q)) {
      const markdown = markdownExcerpt(v, query);
      // Empty when the match is only in syntax spanning blocks (e.g. a URL); nothing useful to show.
      return markdown.markdown ? [{ field, markdown }] : [];
    }
    if (field.kind === "string" && typeof v === "string" && v.toLowerCase().includes(q)) {
      return [{ field, text: textExcerpt(v, query) }];
    }
    // HTML: its text around the match (a match only in markup has no text to show).
    if (field.kind === "html" && typeof v === "string") {
      const text = htmlPlainText(v);
      return text.toLowerCase().includes(q) ? [{ field, text: textExcerpt(text, query) }] : [];
    }
    if (field.kind === "checklist") {
      const items = checklistItems(v).filter((i) => i.text.toLowerCase().includes(q));
      if (items.length > 0) return [{ field, text: items.map((i) => textExcerpt(i.text, query)).join(", ") }];
    }
    if (field.kind === "string_list" && Array.isArray(v)) {
      const items = v.filter((s) => s.toLowerCase().includes(q));
      if (items.length > 0) return [{ field, text: items.map((s) => textExcerpt(s, query)).join(", ") }];
    }
    return [];
  });
}

/** The labels of the items the results' item and list-of-items fields point to, by item id. */
async function referencedLabels(repo: Repository, collections: Collection[], items: Item[]): Promise<Map<string, string>> {
  const ids = new Map<string, Set<string>>();
  for (const item of items) {
    for (const field of collections.find((c) => c.id === item.collectionId)?.fields ?? []) {
      const v = item.values[field.id];
      if (!isReferenceKind(field.kind) || !field.targetCollectionId) continue;
      const set = ids.get(field.targetCollectionId) ?? new Set<string>();
      ids.set(field.targetCollectionId, set);
      for (const id of Array.isArray(v) ? v : [v]) if (typeof id === "string") set.add(id);
    }
  }
  const labels = new Map<string, string>();
  for (const [collectionId, set] of ids) {
    const target = collections.find((c) => c.id === collectionId);
    if (!target || set.size === 0) continue;
    for (const l of await repo.listLabels(target, [...set])) if (l.label) labels.set(l.id, l.label);
  }
  return labels;
}

export function SearchPage() {
  const { repo, collections, spaceCollections, space } = useStore();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const typed = params.get("q") ?? "";
  // The results with the query they are for: shown until the next ones are in, so the list
  // doesn't empty (and a spinner flash) on every keystroke.
  // With the labels of the items they point to (for their item and list-of-items fields' excerpts).
  const [results, setResults] = useState<{ query: string; items: Item[]; labels: Map<string, string> } | null>(null);
  const query = results?.query ?? "";
  const [error, setError] = useState<string>();
  // The latest collections, read when the search runs (a collection edit alone doesn't search again).
  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;

  // The box searches as you type: query once typing pauses, not on every keystroke.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      () =>
        repo
          .search(typed, collectionsRef.current, space.id)
          .then(async (items) => ({ items, labels: await referencedLabels(repo, collectionsRef.current, items) }))
          .then(
            ({ items, labels }) => !cancelled && setResults({ query: typed, items, labels }),
            (e) => !cancelled && setError(errorMessage(e)),
          ),
      150,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repo, typed, space.id]);

  // The database matches raw text (including markdown syntax such as URLs); keep only
  // items with a visible match: in the title or in at least one excerpt.
  // (Excerpts parse markdown: computed once per result set, not on every render.)
  const hits = useMemo(
    () =>
      (results?.items ?? []).flatMap((item) => {
        const collection = collections.find((t) => t.id === item.collectionId);
        if (!collection) return [];
        const matches = excerpts(collection, item, query, results!.labels);
        const titleMatches = itemLabel(collection, item).toLowerCase().includes(query.trim().toLowerCase());
        return titleMatches || matches.length > 0 ? [{ item, collection, matches }] : [];
      }),
    [results, collections, query],
  );

  // Collections (of this space) match on their names and description; they are all in memory.
  const q = query.trim().toLowerCase();
  const collectionHits = q
    ? spaceCollections.filter((t) => [t.name, t.pluralName, t.description].some((text) => text.toLowerCase().includes(q)))
    : [];
  const nothingFound = query && results !== null && hits.length === 0 && collectionHits.length === 0;

  return (
    <>
      <PageHeader title="Search" subtitle={typed ? `Results for “${typed}”` : "Type in the search box to find collections and items."} />
      {error && <InlineNotification kind="error" title="Search failed" subtitle={error} onClose={() => setError(undefined)} />}
      {nothingFound && <p className="helper">Nothing found.</p>}
      {collectionHits.length > 0 && (
        <ContainedList label={`${collectionHits.length} ${collectionHits.length === 1 ? "collection" : "collections"}`} kind="on-page">
          {collectionHits.map((t) => (
            <ContainedListItem key={t.id} onClick={() => navigate(`/collections/${t.id}/items`)}>
              <div className="search-hit">
                <div className="search-hit__title">
                  <CollectionIcon name={t.icon} />
                  <span>
                    <Highlight text={t.pluralName} query={query} />
                  </span>
                  {t.name.toLowerCase().includes(q) && !t.pluralName.toLowerCase().includes(q) && (
                    <Tag size="sm" type="cool-gray">
                      <Highlight text={t.name} query={query} />
                    </Tag>
                  )}
                </div>
                {t.description && (
                  <div className="search-hit__snippet">
                    <Highlight text={t.description} query={query} />
                  </div>
                )}
              </div>
            </ContainedListItem>
          ))}
        </ContainedList>
      )}
      {hits.length > 0 && (
        <ContainedList label={`${hits.length}${results?.items.length === 50 ? "+" : ""} items`} kind="on-page">
          {hits.map(({ item, collection, matches }) => {
            return (
              <ContainedListItem key={item.id} onClick={() => navigate(`/collections/${collection.id}/items/${item.id}`)}>
                <div className="search-hit">
                  <div className="search-hit__title">
                    <span>
                      <Highlight text={itemLabel(collection, item)} query={query} />
                    </span>
                    <Tag size="sm" type="cool-gray">
                      {collection.name}
                    </Tag>
                  </div>
                  {matches.map((ex) => (
                    <div key={ex.field.id} className="search-hit__excerpt">
                      <div className="search-hit__field">{ex.field.name}</div>
                      {"markdown" in ex ? (
                        <>
                          <MarkdownView source={ex.markdown.markdown} highlight={query} variant="excerpt" />
                          {ex.markdown.more > 0 && (
                            <div className="search-hit__more">
                              +{ex.markdown.more} more {ex.markdown.more === 1 ? "match" : "matches"}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="search-hit__snippet">
                          <Highlight text={ex.text} query={query} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ContainedListItem>
            );
          })}
        </ContainedList>
      )}
    </>
  );
}
