import { useEffect, useRef, useState, useMemo } from "react";
import { checklistItems } from "../domain/checklist";
import { htmlPlainText } from "../domain/fieldKinds";
import { useNavigate, useSearchParams } from "react-router";
import { ContainedList, ContainedListItem, InlineNotification, Tag } from "@carbon/react";
import { useStore } from "../app/store";
import { markdownExcerpt, type MarkdownExcerpt } from "../domain/markdownExcerpt";
import { objectLabel, labelField, type FieldDef, type ObjectInstance, type ObjectType } from "../domain/model";
import { Highlight } from "../ui/Highlight";
import { TypeIcon } from "../ui/typeIcons";
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
 * An excerpt for every field whose value contains the query, in field order.
 * The label field is skipped: it is already shown (highlighted) as the result's title.
 */
function excerpts(type: ObjectType, object: ObjectInstance, query: string): Excerpt[] {
  const q = query.toLowerCase();
  const title = labelField(type, object);
  return type.fields.flatMap((field): Excerpt[] => {
    if (field.id === title?.id) return [];
    const v = object.values[field.id];
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

export function SearchPage() {
  const { repo, types } = useStore();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const typed = params.get("q") ?? "";
  // The results with the query they are for: shown until the next ones are in, so the list
  // doesn't empty (and a spinner flash) on every keystroke.
  const [results, setResults] = useState<{ query: string; objects: ObjectInstance[] } | null>(null);
  const query = results?.query ?? "";
  const [error, setError] = useState<string>();
  // The latest types, read when the search runs (a type edit alone doesn't search again).
  const typesRef = useRef(types);
  typesRef.current = types;

  // The box searches as you type: query once typing pauses, not on every keystroke.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      () =>
        repo.search(typed, typesRef.current).then(
          (objects) => !cancelled && setResults({ query: typed, objects }),
          (e) => !cancelled && setError(errorMessage(e)),
        ),
      150,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repo, typed]);

  // The database matches raw text (including markdown syntax such as URLs); keep only
  // objects with a visible match: in the title or in at least one excerpt.
  // (Excerpts parse markdown: computed once per result set, not on every render.)
  const hits = useMemo(
    () =>
      (results?.objects ?? []).flatMap((object) => {
        const type = types.find((t) => t.id === object.typeId);
        if (!type) return [];
        const matches = excerpts(type, object, query);
        const titleMatches = objectLabel(type, object).toLowerCase().includes(query.trim().toLowerCase());
        return titleMatches || matches.length > 0 ? [{ object, type, matches }] : [];
      }),
    [results, types, query],
  );

  // Objects (types) match on their names and description; they are all in memory.
  const q = query.trim().toLowerCase();
  const typeHits = q
    ? types.filter((t) => [t.name, t.pluralName, t.description].some((text) => text.toLowerCase().includes(q)))
    : [];
  const nothingFound = query && results !== null && hits.length === 0 && typeHits.length === 0;

  return (
    <>
      <PageHeader title="Search" subtitle={typed ? `Results for “${typed}”` : "Type in the search box to find types and objects."} />
      {error && <InlineNotification kind="error" title="Search failed" subtitle={error} onClose={() => setError(undefined)} />}
      {nothingFound && <p className="helper">Nothing found.</p>}
      {typeHits.length > 0 && (
        <ContainedList label={`${typeHits.length} ${typeHits.length === 1 ? "type" : "types"}`} kind="on-page">
          {typeHits.map((t) => (
            <ContainedListItem key={t.id} onClick={() => navigate(`/types/${t.id}/objects`)}>
              <div className="search-hit">
                <div className="search-hit__title">
                  <TypeIcon name={t.icon} />
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
        <ContainedList label={`${hits.length}${results?.objects.length === 50 ? "+" : ""} objects`} kind="on-page">
          {hits.map(({ object, type, matches }) => {
            return (
              <ContainedListItem key={object.id} onClick={() => navigate(`/types/${type.id}/objects/${object.id}`)}>
                <div className="search-hit">
                  <div className="search-hit__title">
                    <span>
                      <Highlight text={objectLabel(type, object)} query={query} />
                    </span>
                    <Tag size="sm" type="cool-gray">
                      {type.name}
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
