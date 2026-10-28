import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  Accordion,
  AccordionItem,
  IconButton,
  InlineNotification,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tile,
} from "@carbon/react";
import { Copy, Edit, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useTableSort } from "../ui/useTableSort";
import { LIST_MAIN, LIST_TABLE } from "../ui/listTable";
import { inSpace } from "../domain/spaces";
import { isRemote } from "../domain/sources";
import { useDataChanges } from "../app/useDataChanges";
import {
  blankField,
  countLabel,
  newId,
  nextName,
  collectionDraft,
  type FieldDef,
  type Collection,
} from "../domain/model";
import { newItemViewId } from "../domain/fieldLayout";
import { cellEditStart, type EditStart } from "../ui/editStart";
import { FieldEditor } from "../ui/FieldEditor";
import { CollectionIcon } from "../ui/collectionIcons";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { RowActions, ROW_BUTTON } from "../ui/RowActions";
import { FillTable, useSharedColumns } from "../views/TableView";

/**
 * The collections as a table, like the Components page: name (opens its items), description
 * (edits in place), the spaces it is shown in (once there are several; all collections are listed,
 * so one kept out of this space can still be edited: grouped under "Not in this space", where the
 * name isn't a link as its items can't be shown here), and per row an edit (the collection
 * editor), duplicate and delete icon. Item counts (of every space) are kept for the delete
 * confirmation.
 *
 * Native collections only: remote ones (read from the server's remote connections) are listed,
 * added and edited on the Remotes page, the same table with a Source column (`remote`).
 */
/** The description, edited in its cell with the shared field editor as a one-line text field. */
const descriptionField = (t: Collection): FieldDef => blankField(`description-${t.id}`, "Description", "string", { collectionId: t.id });

const draftOf = collectionDraft;

export function CollectionsPage({ remote = false }: { remote?: boolean }) {
  const { repo, collections: all, spaces, space } = useStore();
  const collections = all.filter((t) => isRemote(t) === remote);
  // Where a collection is edited and new ones are made: remote ones under Remotes.
  const base = remote ? "/remotes" : "/collections";
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const spaceNames = (t: Collection) =>
    t.spaceIds === null
      ? "All"
      : spaces
          .filter((s) => t.spaceIds!.includes(s.id))
          .map((s) => s.name)
          .join(", ");
  const here = collections.filter((t) => inSpace(t, space.id));
  const elsewhere = collections.filter((t) => !inSpace(t, space.id));
  const groups = [
    { label: "In this space", list: here },
    { label: "Not in this space", list: elsewhere },
  ].filter((g) => g.list.length > 0);
  const groupsBox = useRef<HTMLDivElement>(null);
  useSharedColumns(groupsBox, elsewhere.length > 0);
  const { sort, header } = useTableSort<Collection, "name" | "source" | "description" | "spaces">({
    name: (t) => t.pluralName,
    source: (t) => t.source?.name ?? "",
    description: (t) => t.description,
    spaces: spaceNames,
  });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string>();
  // The collection whose description is being edited in its cell, and where it was clicked.
  const [editing, setEditing] = useState<{
    id: string;
    start?: EditStart;
  } | null>(null);

  const loadCounts = () =>
    repo
      .countItemsByCollection(null)
      .then(setCounts, (e) => setError(errorMessage(e)));
  useEffect(() => {
    loadCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, all]);
  useDataChanges((change) => change.scope === "items" && loadCounts());

  async function remove(collection: Collection) {
    const n = counts[collection.id] ?? 0;
    const ok = await confirm({
      title: `Delete “${collection.pluralName}”?`,
      // A remote collection's rows stay where they are: only its fields and views go.
      body: collection.source
        ? `This removes the collection, its fields and its views. ${collection.source.name} is not affected.`
        : `This removes the collection, its fields and its ${countLabel(collection, n)}.`,
    });
    if (!ok) return;
    try {
      await repo.deleteCollection(collection.id); // the store reloads the collections (it hears the change)
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * A copy of a collection: its fields (new ids; components and choice filters follow them), icon,
   * description and item views; not its items. Names numbered: "Book 2" / "Books 2".
   */
  async function duplicate(t: Collection) {
    const id = newId();
    const ids = new Map(t.fields.map((f) => [f.id, newId()]));
    const mapId = (fieldId: string) => ids.get(fieldId) ?? fieldId;
    const self = (targetCollectionId: string | null) =>
      targetCollectionId === t.id;
    const draft = collectionDraft(t);
    try {
      await repo.saveCollection(
        {
          ...draft,
          id,
          name: nextName(
            t.name,
            all.map((x) => x.name),
          ),
          pluralName: nextName(
            t.pluralName,
            all.map((x) => x.pluralName),
          ),
          // Its title field is the copy's (NO_TITLE and null map to themselves).
          titleField: draft.titleField ? mapId(draft.titleField) : null,
          fields: draft.fields.map((f) => ({
            ...f,
            id: mapId(f.id),
            // A reference to the collection itself refers to the copy.
            targetCollectionId: self(f.targetCollectionId)
              ? id
              : f.targetCollectionId,
            choiceFilter: self(f.targetCollectionId)
              ? f.choiceFilter.map((r) => ({
                  ...r,
                  id: newId(),
                  fieldId: mapId(r.fieldId),
                }))
              : f.choiceFilter,
          })),
        },
        space.id,
      );
      // Stored item views only (without, the copy shows the standard "Default" too).
      const views = t.itemViews.filter((v) => v.id !== "default");
      if (views.length) {
        await repo.saveItemViews(
          id,
          views.map((v) => ({
            ...v,
            id: newItemViewId(),
            layout: {
              ...v.layout,
              fields: v.layout.fields?.map(mapId) ?? null,
              hiddenLabels: v.layout.hiddenLabels.map(mapId),
            },
            // Collapsed fields too (blocks keep their ids).
            collapsed: { ...v.collapsed, blocks: v.collapsed.blocks.map(mapId) },
          })),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const table = (list: Collection[]) => (
    <FillTable>
      <Table size="sm" className={LIST_TABLE}>
        <TableHead>
          <TableRow>
            <TableHeader className={LIST_MAIN} {...header("name")}>Name</TableHeader>
            {remote && <TableHeader {...header("source")}>Source</TableHeader>}
            <TableHeader {...header("description")}>Description</TableHeader>
            {spaces.length > 1 && <TableHeader {...header("spaces")}>Spaces</TableHeader>}
            <TableHeader aria-label="Actions" />
          </TableRow>
        </TableHead>
        <TableBody>
          {sort(list).map((t) => (
            <TableRow key={t.id}>
              <TableCell className={LIST_MAIN}>
                {inSpace(t, space.id) ? (
                  <Link href={`#/collections/${t.id}/items`}>
                    <span className="icon-label">
                      <CollectionIcon name={t.icon} />
                      <span className="icon-label__text">{t.pluralName}</span>
                    </span>
                  </Link>
                ) : (
                  <span className="icon-label">
                    <CollectionIcon name={t.icon} />
                    <span className="icon-label__text">{t.pluralName}</span>
                  </span>
                )}
              </TableCell>
              {remote && <TableCell>{t.source?.name}</TableCell>}
              {/* Edits in place, like other tables' cells: Enter or clicking away saves, Escape cancels. */}
              <TableCell className={`cell--string${editing?.id === t.id ? " cell--editing" : ""}`}>
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
                          const description =
                            typeof v === "string"
                              ? v.replace(/[\r\n]+/g, " ").trim()
                              : "";
                          if (description !== t.description)
                            await repo.saveCollection(
                              { ...draftOf(t), description },
                              space.id,
                            );
                          setEditing((cur) => (cur?.id === t.id ? null : cur));
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    );
                    if (editing.start?.wrapped)
                      return <div className="cell-inline-editor">{editor}</div>;
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
                    onClick={(e) =>
                      setEditing({
                        id: t.id,
                        start: cellEditStart(e.currentTarget, e),
                      })
                    }
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
              {spaces.length > 1 && (
                <TableCell>{spaceNames(t)}</TableCell>
              )}
              <RowActions>
                <IconButton
                  {...ROW_BUTTON}
                  label={`Edit ${t.pluralName} collection`}
                  onClick={() => navigate(`${base}/${t.id}/edit`)}
                >
                  <Edit />
                </IconButton>
                <IconButton
                  {...ROW_BUTTON}
                  label={`Duplicate ${t.pluralName} collection`}
                  onClick={() => duplicate(t)}
                >
                  <Copy />
                </IconButton>
                <IconButton
                  {...ROW_BUTTON}
                  label={`Delete ${t.pluralName} collection`}
                  onClick={() => remove(t)}
                >
                  <TrashCan />
                </IconButton>
              </RowActions>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </FillTable>
  );

  return (
    <>
      <PageHeader
        title={remote ? "Remotes" : "Collections"}
        subtitle={
          remote
            ? "Tables and queries of the server's remote connections, shown as read-only collections."
            : "Define the kinds of things you keep track of, and the fields they have."
        }
        actions={
          <NewButton
            label={remote ? "New remote collection" : "New collection"}
            onClick={() => navigate(`${base}/new`)}
          />
        }
      />
      {error && (
        <InlineNotification
          kind="error"
          title="Error"
          subtitle={error}
          onClose={() => setError(undefined)}
        />
      )}

      {collections.length === 0 ? (
        <Tile className="empty-state">
          <p>
            {remote
              ? "No remote collections yet. Add one to show a table or query of one of the server's remote connections."
              : "No collections yet. Start by creating one, for example “Book”, “Person” or “Meeting”."}
          </p>
        </Tile>
      ) : (
        <div
          ref={groupsBox}
          className={elsewhere.length > 0 ? "table-groups" : undefined}
        >
          {elsewhere.length === 0 ? (
            table(here)
          ) : (
            <Accordion size="sm" align="start">
              {groups.map(({ label, list }) => (
                <AccordionItem
                  key={label}
                  open
                  title={
                    <span className="table-group__title">
                      {label}{" "}
                      <span className="view-group__count">{list.length}</span>
                    </span>
                  }
                >
                  {table(list)}
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </div>
      )}
      {dialog}
    </>
  );
}
