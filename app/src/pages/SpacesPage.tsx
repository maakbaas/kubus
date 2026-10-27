import { useEffect, useState } from "react";
import { IconButton, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@carbon/react";
import { ArrowRight, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { newId, nextName, type FieldDef } from "../domain/model";
import type { Space } from "../domain/spaces";
import { cellEditStart, type EditStart } from "../ui/editStart";
import { FieldEditor } from "../ui/FieldEditor";
import { IconPicker } from "../ui/IconPicker";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { useTableSort } from "../ui/useTableSort";
import { RowActions, rowButtonProps } from "../ui/RowActions";
import { SPACE_ICON } from "../ui/SpaceSwitcher";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { FillTable } from "../views/TableView";

/** The name, edited in its cell with the shared field editor as a one-line text field. */
const nameField = (s: Space): FieldDef => ({
  id: `space-name-${s.id}`,
  collectionId: "",
  name: "Name",
  kind: "string",
  targetCollectionId: null,
  componentId: null,
  componentArgs: {},
  choiceFilter: [],
  toggleIcon: null, strikeThrough: false,
  aiPrompt: null,
  aiOutput: null,
  position: 0,
});

/**
 * The spaces as a table: icon (picker), name (edits in place, taking the row's spare width), and per row a switch
 * (show that space) and a delete icon. The counts only feed the delete confirmation. Collections and components are shared by every space;
 * items, collection views, bookmarks and open tabs belong to one. Any space can be deleted while another remains (deleting the shown one opens the next).
 */
export function SpacesPage() {
  const { repo, spaces, space: shown, setSpace } = useStore();
  const { confirm, dialog } = useConfirm();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<{ id: string; start?: EditStart } | null>(null);
  const fail = (e: unknown) => setError(errorMessage(e));
  const { sort, header } = useTableSort<Space, "name">({ name: (s) => s.name });

  const loadCounts = () =>
    Promise.all(spaces.map((s) => repo.countItemsByCollection(s.id).then((n) => [s.id, Object.values(n).reduce((a, b) => a + b, 0)] as const)))
      .then((list) => setCounts(Object.fromEntries(list)), fail);
  useEffect(() => {
    loadCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, spaces]);
  useDataChanges((change) => change.scope === "items" && loadCounts());

  const save = (s: Space, change: Partial<Pick<Space, "name" | "icon">>) => repo.saveSpace({ ...s, ...change }).catch(fail);

  async function add() {
    const id = newId();
    const name = nextName("Space", spaces.map((s) => s.name));
    try {
      await repo.saveSpace({ id, name, icon: null });
      setEditing({ id });
    } catch (e) {
      fail(e);
    }
  }

  async function remove(s: Space) {
    const n = counts[s.id] ?? 0;
    const ok = await confirm({
      title: `Delete space “${s.name}”?`,
      body: `This removes the space, its views, its bookmarks and its ${n} ${n === 1 ? "item" : "items"}. Collections and components stay (they belong to every space).`,
    });
    if (!ok) return;
    try {
      // Deleting the shown space opens the next one (the previous, for the last).
      const i = spaces.indexOf(s);
      if (s.id === shown.id) setSpace((spaces[i + 1] ?? spaces[i - 1]).id);
      await repo.deleteSpace(s.id);
    } catch (e) {
      fail(e);
    }
  }

  return (
    <>
      <PageHeader
        title="Spaces"
        subtitle="Separate environments like Work and Private, each with its own items. Collections and components are shared."
        actions={<NewButton label="New space" onClick={add} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      <FillTable>
        <Table size="sm">
          <TableHead>
            <TableRow>
              <TableHeader>Icon</TableHeader>
              {/* As wide as the row allows, so the name's input opens at a usable width. */}
              <TableHeader style={{ inlineSize: "100%" }} {...header("name")}>Name</TableHeader>
              <TableHeader aria-label="Actions" />
            </TableRow>
          </TableHead>
          <TableBody>
            {sort(spaces).map((s) => (
              <TableRow key={s.id}>
                <TableCell className="space-icon">
                  <IconPicker id={`space-icon-${s.id}`} value={s.icon ?? SPACE_ICON} size={16} onChange={(icon) => save(s, { icon })} />
                </TableCell>
                {/* Edits in place like the Collections page's descriptions: the input covers the cell, text unmoved. */}
                <TableCell data-label="Name" className={`cell--string${editing?.id === s.id ? " cell--editing" : ""}`}>
                  {editing?.id === s.id ? (
                    (() => {
                      const editor = (
                        <FieldEditor
                          field={nameField(s)}
                          value={s.name}
                          refs={{}}
                          compact
                          start={editing.start}
                          idPrefix={`space-name-${s.id}`}
                          onSave={async (v) => {
                            const name = typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim() : "";
                            if (name && name !== s.name) await save(s, { name });
                            setEditing((cur) => (cur?.id === s.id ? null : cur));
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      );
                      if (editing.start?.wrapped) return <div className="cell-inline-editor">{editor}</div>;
                      return (
                        <div className="cell-edit-box">
                          <div className="cell-editable cell-sizer" aria-hidden>
                            {s.name}
                          </div>
                          <div className="cell-overlay">{editor}</div>
                        </div>
                      );
                    })()
                  ) : (
                    <div
                      className="cell-editable"
                      role="button"
                      tabIndex={0}
                      aria-label={`Rename ${s.name}`}
                      onClick={(e) => setEditing({ id: s.id, start: cellEditStart(e.currentTarget, e) })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditing({ id: s.id });
                        }
                      }}
                    >
                      {s.name}
                    </div>
                  )}
                </TableCell>
                <RowActions>
                  {(inMenu) => {
                    const btn = rowButtonProps(inMenu);
                    return (
                      <>
                        <IconButton {...btn} label={`Switch to ${s.name}`} disabled={s.id === shown.id} onClick={() => setSpace(s.id)}>
                          <ArrowRight />
                        </IconButton>
                        <IconButton
                          {...btn}
                          label={spaces.length < 2 ? "The only space can't be deleted" : `Delete ${s.name}`}
                          disabled={spaces.length < 2}
                          onClick={() => remove(s)}
                        >
                          <TrashCan />
                        </IconButton>
                      </>
                    );
                  }}
                </RowActions>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </FillTable>
      {dialog}
    </>
  );
}
