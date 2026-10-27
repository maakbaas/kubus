import { useEffect, useId, useState } from "react";
import { Button, ComboBox, Dropdown, InlineNotification, Select, SelectItem, Stack, TextArea } from "@carbon/react";
import { Renew } from "@carbon/icons-react";
import type { SourceInfo, SourceTable, SourceTarget } from "../../../shared/sources";
import { useStore } from "../app/store";
import type { CollectionDraft } from "../domain/model";
import { namesOfTable, withSourceColumns } from "../domain/sources";
import { errorMessage } from "./useConfirm";

// Where a remote collection reads from (collection editor): one of the server's sources, its table
// or a query in its language, and the column that tells rows apart. Reading the columns makes the
// fields (shared/sources.ts); reading them again later keeps what was set up of the fields.

const tableLabel = (t: { schema: string | null; name: string } | null | undefined) => (t ? (t.schema ? `${t.schema}.${t.name}` : t.name) : "");

interface Props {
  draft: CollectionDraft;
  /** A collection being made: its source can still be chosen, its names follow the table. */
  isNew: boolean;
  /** Its names haven't been typed yet (they follow the table). */
  namesFree: boolean;
  problem?: string;
  onChange(draft: CollectionDraft): void;
}

export function SourceSettings({ draft, isNew, namesFree, problem, onChange }: Props) {
  const uid = useId();
  const { sources } = useStore();
  const source = draft.source;
  const [offered, setOffered] = useState<SourceInfo[] | null>(null);
  const [tables, setTables] = useState<SourceTable[] | null>(null);
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [dropped, setDropped] = useState<{ name: string; type: string }[]>([]);
  const target = source?.target;
  const [mode, setMode] = useState<"table" | "query">(target && "query" in target ? "query" : "table");
  const [query, setQuery] = useState(target && "query" in target ? target.query : "");
  const sourceName = source?.name ?? "";
  const info = offered?.find((s) => s.name === sourceName);

  useEffect(() => {
    sources.list().then(setOffered, (e) => setError(errorMessage(e)));
  }, [sources]);
  useEffect(() => {
    if (!sourceName) return;
    setTables(null);
    sources.tables(sourceName).then(setTables, (e) => setError(errorMessage(e)));
  }, [sources, sourceName]);

  /** Reads the columns of what it is to read, and makes (or keeps) the fields for them. */
  async function read(name: string, next: SourceTarget) {
    setReading(true);
    setError(undefined);
    try {
      const description = await sources.describe(name, next);
      setDropped(description.dropped);
      let updated = withSourceColumns(draft, name, next, description);
      if (isNew && namesFree && "table" in next) updated = { ...updated, ...namesOfTable(next.table.name) };
      onChange(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  }

  const chosenTable = target && "table" in target ? (tables?.find((t) => t.schema === target.table.schema && t.name === target.table.name) ?? null) : null;
  return (
    <Stack gap={5}>
      {error && <InlineNotification kind="error" title="Source" subtitle={error} lowContrast hideCloseButton />}
      <Dropdown<SourceInfo>
        autoAlign
        size="sm"
        id={`${uid}-source`}
        titleText="Source"
        label={offered === null ? "Loading…" : offered.length === 0 ? "The server offers no sources" : "Choose a source"}
        helperText={isNew ? "The databases the Kubus server reads for you (set up on the server)." : undefined}
        items={offered ?? []}
        disabled={!isNew || !offered?.length}
        selectedItem={info}
        itemToString={(s) => (s ? (s.problem ? `${s.name} (${s.problem})` : s.name) : sourceName)}
        onChange={({ selectedItem }) => {
          if (!selectedItem || selectedItem.name === sourceName) return;
          setDropped([]);
          // Another source: nothing of the last one's columns applies.
          onChange({ ...draft, source: { name: selectedItem.name, target: { table: { schema: null, name: "" } }, key: "", columns: [] }, fields: draft.fields.filter((f) => !f.column) });
        }}
      />
      {sourceName && info?.capabilities.query && (
        <Select id={`${uid}-mode`} size="sm" labelText="Reads" value={mode} onChange={(e) => setMode(e.target.value === "query" ? "query" : "table")}>
          <SelectItem value="table" text="A table" />
          <SelectItem value="query" text={`A query (${info.capabilities.queryLanguage ?? "its own language"})`} />
        </Select>
      )}
      {sourceName && mode === "table" && (
        <ComboBox<SourceTable>
          autoAlign
          size="sm"
          id={`${uid}-table`}
          titleText="Table"
          placeholder={tables === null ? "Loading…" : "Choose a table or view"}
          items={tables ?? []}
          selectedItem={chosenTable}
          itemToString={(t) => (t ? `${tableLabel(t)}${t.type === "view" ? " (view)" : ""}` : "")}
          onChange={({ selectedItem }) => selectedItem && void read(sourceName, { table: { schema: selectedItem.schema, name: selectedItem.name } })}
        />
      )}
      {sourceName && mode === "query" && (
        <>
          <TextArea
            id={`${uid}-query`}
            className="source-query"
            labelText="Query"
            helperText="One statement, only read: views filter, sort and page what it returns. Name every column (… AS name)."
            rows={6}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div>
            <Button kind="tertiary" size="sm" disabled={reading || !query.trim()} onClick={() => void read(sourceName, { query })}>
              Read columns
            </Button>
          </div>
        </>
      )}
      {source && source.columns.length > 0 && (
        <Dropdown<string>
          autoAlign
          size="sm"
          id={`${uid}-key`}
          titleText="Key"
          label="The column that tells rows apart"
          helperText="Unique for each row: it opens a row's page. The primary key when there is one."
          items={source.columns.map((c) => c.name)}
          selectedItem={source.key || undefined}
          invalid={!!problem}
          invalidText={problem}
          onChange={({ selectedItem }) => selectedItem && onChange({ ...draft, source: { ...source, key: selectedItem } })}
        />
      )}
      {source && !isNew && source.columns.length > 0 && (
        <div>
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Renew}
            disabled={reading || (mode === "query" && !query.trim())}
            onClick={() => void read(source.name, mode === "query" ? { query } : source.target)}
          >
            Read columns again
          </Button>
        </div>
      )}
      {dropped.length > 0 && <p className="helper">Not read: {dropped.map((d) => `${d.name} (${d.type})`).join(", ")}.</p>}
      {problem && !(source && source.columns.length > 0) && <p className="code-editor__invalid">{problem}</p>}
    </Stack>
  );
}
