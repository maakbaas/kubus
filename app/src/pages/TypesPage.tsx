import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { IconButton, InlineNotification, Link, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tile } from "@carbon/react";
import { Copy, Edit, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { countLabel, newId, nextName, typeDraft, type FieldDef, type ObjectType } from "../domain/model";
import { newObjectViewId } from "../domain/fieldLayout";
import { cellEditStart, type EditStart } from "../ui/editStart";
import { FieldEditor } from "../ui/FieldEditor";
import { TypeIcon } from "../ui/typeIcons";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { RowActions, rowButtonProps } from "../ui/RowActions";
import { FillTable } from "../views/TableView";

/**
 * The types as a table, like the Templates page: name (opens its objects) and
 * description (edits in place), and per row an edit (the type editor) and a delete icon. Object counts are kept for the delete
 * confirmation.
 */
/** The description, edited in its cell with the shared field editor as a one-line text field. */
const descriptionField = (t: ObjectType): FieldDef => ({
  id: `description-${t.id}`,
  typeId: t.id,
  name: "Description",
  kind: "string",
  targetTypeId: null,
  templateId: null,
  templateArgs: {},
  choiceFilter: [],
  toggleIcon: null,
  position: 0,
});

const draftOf = typeDraft;

export function TypesPage() {
  const { repo, types } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string>();
  // The type whose description is being edited in its cell, and where it was clicked.
  const [editing, setEditing] = useState<{ id: string; start?: EditStart } | null>(null);

  const loadCounts = () => repo.countObjectsByType().then(setCounts, (e) => setError(errorMessage(e)));
  useEffect(() => {
    loadCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, types]);
  useDataChanges((change) => change.scope === "objects" && loadCounts());

  async function remove(type: ObjectType) {
    const n = counts[type.id] ?? 0;
    const ok = await confirm({
      title: `Delete “${type.pluralName}”?`,
      body: `This removes the type, its fields and its ${countLabel(type, n)}.`,
    });
    if (!ok) return;
    try {
      await repo.deleteType(type.id); // the store reloads the types (it hears the change)
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * A copy of a type: its fields (new ids; templates and choice filters follow them), icon,
   * description and object views; not its objects. Names numbered: "Book 2" / "Books 2".
   */
  async function duplicate(t: ObjectType) {
    const id = newId();
    const ids = new Map(t.fields.map((f) => [f.id, newId()]));
    const mapId = (fieldId: string) => ids.get(fieldId) ?? fieldId;
    const self = (targetTypeId: string | null) => targetTypeId === t.id;
    const draft = typeDraft(t);
    try {
      await repo.saveType({
        ...draft,
        id,
        name: nextName(t.name, types.map((x) => x.name)),
        pluralName: nextName(t.pluralName, types.map((x) => x.pluralName)),
        fields: draft.fields.map((f) => ({
          ...f,
          id: mapId(f.id),
          // A reference to the type itself refers to the copy.
          targetTypeId: self(f.targetTypeId) ? id : f.targetTypeId,
          templateArgs: Object.fromEntries(
            Object.entries(f.templateArgs).map(([k, arg]) => [k, "field" in arg ? { field: mapId(arg.field) } : arg]),
          ),
          choiceFilter: self(f.targetTypeId) ? f.choiceFilter.map((r) => ({ ...r, id: newId(), fieldId: mapId(r.fieldId) })) : f.choiceFilter,
        })),
      });
      // Stored object views only (without, the copy shows the standard "Default" too).
      const views = t.objectViews.filter((v) => v.id !== "default");
      if (views.length) {
        await repo.saveObjectViews(
          id,
          views.map((v) => ({
            ...v,
            id: newObjectViewId(),
            layout: { ...v.layout, fields: v.layout.fields?.map(mapId) ?? null, hiddenLabels: v.layout.hiddenLabels.map(mapId) },
          })),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Types"
        subtitle="Define the kinds of things you keep track of, and the fields they have."
        actions={<NewButton label="New type" onClick={() => navigate("/types/new")} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}

      {types.length === 0 ? (
        <Tile className="empty-state">
          <p>No types yet. Start by creating one, for example “Book”, “Person” or “Meeting”.</p>
        </Tile>
      ) : (
        <FillTable>
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Description</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {types.map((t) => (
                <TableRow key={t.id}>
                  <TableCell data-label="Name">
                    <Link href={`#/types/${t.id}/objects`}>
                      <span className="icon-label">
                        <TypeIcon name={t.icon} />
                        {t.pluralName}
                      </span>
                    </Link>
                  </TableCell>
                  {/* Edits in place, like other tables' cells: Enter or clicking away saves, Escape cancels. */}
                  <TableCell data-label="Description" className={`cell--string${editing?.id === t.id ? " cell--editing" : ""}`}>
                    {editing?.id === t.id ? (
                      (() => {
                        const editor = (
                          <FieldEditor
                            field={descriptionField(t)}
                            value={t.description || null}
                            refs={{}}
                            compact
                            start={editing.start}
                            idPrefix={`description-${t.id}`}
                            onSave={async (v) => {
                              const description = typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim() : "";
                              if (description !== t.description) await repo.saveType({ ...draftOf(t), description });
                              setEditing((cur) => (cur?.id === t.id ? null : cur));
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        );
                        if (editing.start?.wrapped) return <div className="cell-inline-editor">{editor}</div>;
                        return (
                          <div className="cell-edit-box">
                            <div className="cell-editable cell-sizer" aria-hidden>
                              {t.description}
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
                        aria-label={`Edit description of ${t.pluralName}`}
                        onClick={(e) => setEditing({ id: t.id, start: cellEditStart(e.currentTarget, e) })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setEditing({ id: t.id });
                          }
                        }}
                      >
                        {t.description}
                      </div>
                    )}
                  </TableCell>
                  <RowActions>
                    {(inMenu) => {
                      const btn = rowButtonProps(inMenu);
                      return (
                        <>
                          <IconButton {...btn} label={`Edit ${t.pluralName} type`} onClick={() => navigate(`/types/${t.id}/edit`)}>
                            <Edit />
                          </IconButton>
                          <IconButton {...btn} label={`Duplicate ${t.pluralName} type`} onClick={() => duplicate(t)}>
                            <Copy />
                          </IconButton>
                          <IconButton {...btn} label={`Delete ${t.pluralName} type`} onClick={() => remove(t)}>
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
      )}
      {dialog}
    </>
  );
}
