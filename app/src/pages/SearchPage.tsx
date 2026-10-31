import { useEffect, useRef, useState, useMemo } from "react";
import { checklistItems } from "../domain/checklist";
import { htmlPlainText } from "../domain/fieldKinds";
import { useNavigate, useSearchParams } from "react-router";
import { ContainedList, ContainedListItem, InlineNotification, Tag } from "@carbon/react";
import { useStore } from "../app/store";
import { useLinkTargets } from "../app/useLinkTargets";
import { isAddressQuery, withoutShown, type LinkTarget } from "../domain/linkTargets";
import { LinkTargetList } from "../ui/LinkTargetList";
import type { Repository } from "../data/repository";
import { markdownExcerpt, type MarkdownExcerpt } from "../domain/markdownExcerpt";
import { editableField, isReferenceKind, itemLabel, labelField, stringList, type FieldDef, type Item, type Collection } from "../domain/model";
import { containsQuery } from "../domain/tags";
import { Highlight, matcher } from "../ui/Highlight";
import type { CollectionView, ViewBlock } from "../domain/views";
import { dashboardIcon, dashboardViewsIn, type DashboardView } from "../domain/dashboards";
import type { MarkdownBlockOptions } from "../views/MarkdownBlock";
import { CollectionIcon } from "../ui/collectionIcons";
import { MarkdownView } from "../ui/MarkdownView";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";

type Excerpt = { field: FieldDef; markdown: MarkdownExcerpt } | { field: FieldDef; text: string };

/** Plain text around the first match. */
function textExcerpt(text: string, query: string, exactTag: boolean): string {
  const m = matcher(query, exactTag)?.exec(text);
  const i = m?.index ?? 0;
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + (m?.[0].length ?? 0) + 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/**
 * An excerpt for every field whose value contains the query (`exactTag`: see containsQuery),
 * in field order: an AI field as its
 * output, an item or list-of-items field by the labels of the items it points to (`labels`).
 * The label field is skipped: it is already shown (highlighted) as the result's title.
 */
function excerpts(collection: Collection, item: Item, query: string, exactTag: boolean, labels: Map<string, string>): Excerpt[] {
  const has = (text: string) => containsQuery(text, query, exactTag);
  const title = labelField(collection, item);
  return collection.fields.flatMap((def): Excerpt[] => {
    if (def.id === title?.id) return [];
    const field = editableField(def);
    const v = item.values[field.id];
    if (isReferenceKind(field.kind)) {
      const ids = Array.isArray(v) ? stringList(v) : typeof v === "string" ? [v] : [];
      const found = ids.flatMap((id) => labels.get(id) ?? []).filter(has);
      if (found.length > 0) return [{ field, text: found.map((label) => textExcerpt(label, query, exactTag)).join(", ") }];
    }
    if (field.kind === "markdown" && typeof v === "string" && has(v.replace(/\\/g, ""))) {
      const markdown = markdownExcerpt(v, query, exactTag);
      // Empty when the match is only in syntax spanning blocks (e.g. a URL); nothing useful to show.
      return markdown.markdown ? [{ field, markdown }] : [];
    }
    if (field.kind === "string" && typeof v === "string" && has(v)) {
      return [{ field, text: textExcerpt(v, query, exactTag) }];
    }
    // HTML: its text around the match (a match only in markup has no text to show).
    if (field.kind === "html" && typeof v === "string") {
      const text = htmlPlainText(v);
      return has(text) ? [{ field, text: textExcerpt(text, query, exactTag) }] : [];
    }
    if (field.kind === "checklist") {
      const items = checklistItems(v).filter((i) => has(i.text));
      if (items.length > 0) return [{ field, text: items.map((i) => textExcerpt(i.text, query, exactTag)).join(", ") }];
    }
    if ((field.kind === "string_list" || field.kind === "number_list") && Array.isArray(v)) {
      const items = stringList(v).filter(has);
      if (items.length > 0) return [{ field, text: items.map((s) => textExcerpt(s, query, exactTag)).join(", ") }];
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

/**
 * The Markdown blocks of these views (a collection view's or a dashboard view: one place each; an item view's text
 * is the same on all its items, so it is left out) whose text visibly contains the query.
 */
function blockExcerpts<V extends { blocks: ViewBlock[] }>(views: V[], query: string, exactTag: boolean): { view: V; block: ViewBlock; markdown: MarkdownExcerpt }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return views.flatMap((view) =>
    view.blocks.flatMap((block) => {
      const text = block.kind === "markdown" ? (block.options as MarkdownBlockOptions | null)?.text : undefined;
      // Without its backslash escapes, as Markdown fields are matched (SqliteRepository.search).
      if (typeof text !== "string" || !containsQuery(text.replace(/\\/g, ""), query, exactTag)) return [];
      const markdown = markdownExcerpt(text, query, exactTag);
      return markdown.markdown ? [{ view, block, markdown }] : [];
    }),
  );
}

export function SearchPage() {
  const { repo, collections, spaceCollections, spaceDashboards, space } = useStore();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const typed = params.get("q") ?? "";
  // Opened from a tag (TagChip): exactly that tag; a typed search is for text.
  const typedTag = params.get("tag") === "1";
  // The results with the query they are for: shown until the next ones are in, so the list
  // doesn't empty (and a spinner flash) on every keystroke.
  // With the labels of the items they point to (for their item and list-of-items fields' excerpts).
  // And the collection views and dashboard tabs of this space, for their Markdown blocks.
  const [results, setResults] = useState<{ query: string; exactTag: boolean; items: Item[]; labels: Map<string, string>; views: CollectionView[]; tabs: DashboardView[] } | null>(null);
  const query = results?.query ?? "";
  const exactTag = results?.exactTag ?? false;
  const [error, setError] = useState<string>();
  // The latest collections, read when the search runs (a collection edit alone doesn't search again).
  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;

  // The box searches as you type: query once typing pauses, not on every keystroke.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      () =>
        Promise.all([
          repo
            .search(typed, collectionsRef.current, space.id)
            .then(async (items) => ({ items, labels: await referencedLabels(repo, collectionsRef.current, items) })),
          repo.listAllViews(),
          repo.listAllDashboardViews(),
        ]).then(
          ([{ items, labels }, views, tabs]) =>
            !cancelled && setResults({ query: typed, exactTag: typedTag, items, labels, views: views.filter((v) => v.spaceId === space.id), tabs }),
          (e) => !cancelled && setError(errorMessage(e)),
        ),
      150,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repo, typed, typedTag, space.id]);

  // The database matches raw text (including markdown syntax such as URLs); keep only
  // items with a visible match: in the title or in at least one excerpt.
  // (Excerpts parse markdown: computed once per result set, not on every render.)
  const hits = useMemo(
    () =>
      (results?.items ?? []).flatMap((item) => {
        const collection = collections.find((t) => t.id === item.collectionId);
        if (!collection) return [];
        const matches = excerpts(collection, item, query, exactTag, results!.labels);
        const titleMatches = containsQuery(itemLabel(collection, item), query, exactTag);
        return titleMatches || matches.length > 0 ? [{ item, collection, matches, titleMatches }] : [];
      }),
    [results, collections, query, exactTag],
  );

  // Collections (of this space) match on their names and description; they are all in memory.
  const q = query.trim().toLowerCase();
  const collectionHits = q
    ? spaceCollections.filter((t) => [t.name, t.pluralName, t.description].some((text) => containsQuery(text, q, exactTag)))
    : [];
  // Markdown blocks of this space's collection views (parsed for excerpts: once per result set).
  const blockHits = useMemo(
    () =>
      blockExcerpts(results?.views ?? [], query, exactTag).flatMap((hit) => {
        const collection = spaceCollections.find((c) => c.id === hit.view.collectionId);
        return collection ? [{ ...hit, collection }] : [];
      }),
    [results, spaceCollections, query, exactTag],
  );
  // Dashboards (of this space) match on their names and description, like collections.
  const dashboardHits = q ? spaceDashboards.filter((d) => [d.name, d.description].some((text) => containsQuery(text, q, exactTag))) : [];
  // Markdown blocks of the tabs this space's dashboards show (its own, or copies of another space's).
  const tabBlockHits = useMemo(
    () =>
      spaceDashboards.flatMap((dashboard) =>
        blockExcerpts(dashboardViewsIn(results?.tabs ?? [], dashboard.id, space.id), query, exactTag).map((hit) => ({ ...hit, dashboard })),
      ),
    [results, spaceDashboards, space.id, query, exactTag],
  );
  // Pages whose link address fits what was typed (`#/collections/…`, `book#field`; the Markdown editor's
  // link picker finds the same): the ones not already listed above, each once.
  const { search: searchLinks, reset: resetLinks } = useLinkTargets();
  const [linkFound, setLinkFound] = useState<{ query: string; targets: LinkTarget[] }>({ query: "", targets: [] });
  useEffect(() => {
    if (!results || !isAddressQuery(results.query) || results.exactTag) return;
    let cancelled = false;
    resetLinks();
    searchLinks(results.query, { items: true, limit: 30 }).then(
      (targets) => !cancelled && setLinkFound({ query: results.query, targets }),
      () => !cancelled && setLinkFound({ query: results.query, targets: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [results, searchLinks, resetLinks]);
  const linkHits = useMemo(
    () =>
      linkFound.query === query && !exactTag
        ? withoutShown(linkFound.targets, [...collectionHits.map((t) => `collection:${t.id}`), ...dashboardHits.map((d) => `dashboard:${d.id}`), ...hits.map((h) => `item:${h.item.id}`)])
        : [],
    [linkFound, query, exactTag, collectionHits, dashboardHits, hits],
  );
  const markdownHits = blockHits.length + tabBlockHits.length;
  const nothingFound = query && results !== null && hits.length === 0 && collectionHits.length === 0 && dashboardHits.length === 0 && markdownHits === 0 && linkHits.length === 0;

  return (
    <>
      <PageHeader title="Search" subtitle={typed ? (typedTag ? `Tagged “${typed}”` : `Results for “${typed}”`) : "Type in the search box to find collections, dashboards, Markdown blocks and items."} />
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
                    <Highlight text={t.pluralName} query={query} exactTag={exactTag} />
                  </span>
                  {containsQuery(t.name, q, exactTag) && !containsQuery(t.pluralName, q, exactTag) && (
                    <Tag size="sm" type="cool-gray">
                      <Highlight text={t.name} query={query} exactTag={exactTag} />
                    </Tag>
                  )}
                </div>
                {t.description && (
                  <div className="search-hit__snippet">
                    <Highlight text={t.description} query={query} exactTag={exactTag} />
                  </div>
                )}
              </div>
            </ContainedListItem>
          ))}
        </ContainedList>
      )}
      {dashboardHits.length > 0 && (
        <ContainedList label={`${dashboardHits.length} ${dashboardHits.length === 1 ? "dashboard" : "dashboards"}`} kind="on-page">
          {dashboardHits.map((d) => (
            <ContainedListItem key={d.id} onClick={() => navigate(`/dashboards/${d.id}`)}>
              <div className="search-hit">
                <div className="search-hit__title">
                  <CollectionIcon name={dashboardIcon(d)} />
                  <span>
                    <Highlight text={d.name} query={query} exactTag={exactTag} />
                  </span>
                </div>
                {d.description && (
                  <div className="search-hit__snippet">
                    <Highlight text={d.description} query={query} exactTag={exactTag} />
                  </div>
                )}
              </div>
            </ContainedListItem>
          ))}
        </ContainedList>
      )}
      {linkHits.length > 0 && (
        <LinkTargetList
          targets={linkHits}
          label={`${linkHits.length} ${linkHits.length === 1 ? "link" : "links"}`}
          query={query}
          onPick={(t) => navigate(t.href.slice(1))}
        />
      )}
      {markdownHits > 0 && (
        <ContainedList label={`${markdownHits} Markdown ${markdownHits === 1 ? "block" : "blocks"}`} kind="on-page">
          {tabBlockHits.map(({ view, block, dashboard, markdown }) => (
            <ContainedListItem key={`${view.id}/${block.id}`} onClick={() => navigate(`/dashboards/${dashboard.id}?view=${view.id}&block=${block.id}`)}>
              <div className="search-hit">
                <div className="search-hit__title">
                  <CollectionIcon name={dashboardIcon(dashboard)} />
                  <span>
                    <Highlight text={block.title || "Markdown"} query={query} exactTag={exactTag} />
                  </span>
                  <Tag size="sm" type="cool-gray">
                    {dashboard.name} / {view.name}
                  </Tag>
                </div>
                <div className="search-hit__excerpt">
                  <MarkdownView source={markdown.markdown} highlight={query} exactTag={exactTag} variant="excerpt" />
                  {markdown.more > 0 && (
                    <div className="search-hit__more">
                      +{markdown.more} more {markdown.more === 1 ? "match" : "matches"}
                    </div>
                  )}
                </div>
              </div>
            </ContainedListItem>
          ))}

          {blockHits.map(({ view, block, collection, markdown }) => (
            <ContainedListItem
              key={`${view.id}/${block.id}`}
              onClick={() => navigate(`/collections/${collection.id}/items?view=${view.id}&block=${block.id}`)}
            >
              <div className="search-hit">
                <div className="search-hit__title">
                  <CollectionIcon name={collection.icon} />
                  <span>
                    <Highlight text={block.title || "Markdown"} query={query} exactTag={exactTag} />
                  </span>
                  <Tag size="sm" type="cool-gray">
                    {collection.pluralName} / {view.name}
                  </Tag>
                </div>
                <div className="search-hit__excerpt">
                  <MarkdownView source={markdown.markdown} highlight={query} exactTag={exactTag} variant="excerpt" />
                  {markdown.more > 0 && (
                    <div className="search-hit__more">
                      +{markdown.more} more {markdown.more === 1 ? "match" : "matches"}
                    </div>
                  )}
                </div>
              </div>
            </ContainedListItem>
          ))}
        </ContainedList>
      )}
      {hits.length > 0 && (
        <ContainedList label={`${hits.length}${results?.items.length === 50 ? "+" : ""} items`} kind="on-page">
          {hits.map(({ item, collection, matches, titleMatches }) => {
            // Opened at the first field that matched (scrolled to, where its page shows it); at the
            // top when the title did.
            const at = titleMatches || matches.length === 0 ? "" : `?field=${encodeURIComponent(matches[0].field.id)}`;
            return (
              <ContainedListItem key={item.id} onClick={() => navigate(`/collections/${collection.id}/items/${item.id}${at}`)}>
                <div className="search-hit">
                  <div className="search-hit__title">
                    <span>
                      <Highlight text={itemLabel(collection, item)} query={query} exactTag={exactTag} />
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
                          <MarkdownView source={ex.markdown.markdown} highlight={query} exactTag={exactTag} variant="excerpt" />
                          {ex.markdown.more > 0 && (
                            <div className="search-hit__more">
                              +{ex.markdown.more} more {ex.markdown.more === 1 ? "match" : "matches"}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="search-hit__snippet">
                          <Highlight text={ex.text} query={query} exactTag={exactTag} />
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
