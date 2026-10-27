import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Checkbox, Dropdown, IconButton, InlineNotification, Link, Modal, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, Tile } from "@carbon/react";
import { Copy, Share, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { newId, nextName, now } from "../domain/model";
import { COMPONENT_KINDS, componentUses, localComponents, type Component, type ComponentCode, type LocalComponent } from "../domain/components";
import type { CollectionView } from "../domain/views";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { PromoteComponentModal } from "../ui/PromoteComponentModal";
import { pickShared } from "../ui/promoteLocal";
import { errorMessage } from "../ui/useConfirm";
import { useTableSort } from "../ui/useTableSort";
import { RowActions, rowButtonProps } from "../ui/RowActions";
import { FillTable } from "../views/TableView";

/** A component's kind as the list shows it (Field, Block, Static), from what its code uses. */
function kindLabel(x: ComponentCode): string {
  const uses = componentUses(x.code);
  return uses.mixed ? "Mixed: fix it" : COMPONENT_KINDS[uses.kind];
}

const SCOPES = ["all", "shared", "local"] as const;
type Scope = (typeof SCOPES)[number];
const SCOPE_TEXT: Record<Scope, string> = { all: "All components", shared: "Shared", local: "Written here" };

/** A row of the list: a shared component, or a local one (written in place) by where it is used. */
type Row = { shared: Component; local?: undefined } | { local: LocalComponent; shared?: undefined };
const codeOf = (r: Row): ComponentCode => (r.shared ? r.shared : r.local.component);
const nameOf = (r: Row) => (r.shared ? r.shared.name : r.local.where);

/**
 * The list of components as a table: shared ones (name opens the editor) and local ones, written
 * in place in a field or block (named by where they are used, which the name links to; "Save as
 * shared component" promotes one). Kind ("AI" for those that ask AI), and the component's start.
 * Shared ones are created and edited on their own page (ComponentEditorPage).
 */
export function ComponentsPage() {
  const { repo, collections, components, space } = useStore();
  const navigate = useNavigate();
  // null while loading: the list shows once complete, so the local ones of views don't shift it.
  const [views, setViews] = useState<CollectionView[] | null>(null);
  const loadViews = useCallback(() => {
    repo.listAllViews().then(setViews, (e) => console.error("Loading views failed", e));
  }, [repo]);
  useEffect(loadViews, [loadViews]);
  useDataChanges((change) => change.scope === "views" && loadViews());
  const rows = useMemo<Row[]>(
    () => [...components.map((shared) => ({ shared })), ...localComponents(collections, views ?? []).map((local) => ({ local }))],
    [components, collections, views],
  );
  const { sort, header } = useTableSort<Row, "name" | "kind" | "place" | "description" | "code">({
    name: nameOf,
    kind: (r) => kindLabel(codeOf(r)),
    place: (r) => (r.shared ? "Shared" : "Written here"),
    description: (r) => r.shared?.description ?? "",
    code: (r) => codeOf(r).code.split("\n")[0],
  });
  const [scope, setScope] = useState<Scope>("all");
  const [error, setError] = useState<string>();
  // The component being deleted, and whether the fields using it go too.
  const [deleting, setDeleting] = useState<Component | null>(null);
  const [withFields, setWithFields] = useState(false);
  // The local component being promoted to a shared one.
  const [promoting, setPromoting] = useState<LocalComponent | null>(null);
  const users = deleting
    ? collections.flatMap((t) => t.fields.filter((f) => f.code === null && f.componentId === deleting.id).map((f) => `“${f.name}” of ${t.name}`))
    : [];

  async function remove() {
    if (!deleting) return;
    const x = deleting;
    setDeleting(null);
    try {
      await repo.deleteComponent(x.id, { withFields });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Components"
        subtitle="Code that computes content and values: field components show one item, block components a block's items, static ones the same everywhere; AI ones are prompts for AI fields. Shared ones are picked by name; the others are written in place, in one field or block."
        actions={<NewButton label="New component" onClick={() => navigate("/components/new")} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {/* Shared ones, those written in place, or both. */}
      {views !== null && rows.length > 0 && (
        <div className="components-scope">
          <Dropdown<Scope>
            autoAlign
            type="inline"
            size="sm"
            id="components-scope"
            titleText="Show"
            label="Show"
            items={[...SCOPES]}
            selectedItem={scope}
            itemToString={(s) => (s ? SCOPE_TEXT[s] : "")}
            onChange={({ selectedItem }) => selectedItem && setScope(selectedItem)}
          />
        </div>
      )}
      {views === null ? null : rows.length === 0 ? (
        <Tile className="empty-state">
          <p>No components yet.</p>
        </Tile>
      ) : (
        <FillTable>
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableHeader {...header("name")}>Name</TableHeader>
                <TableHeader {...header("kind")}>Kind</TableHeader>
                <TableHeader {...header("place")}>Where</TableHeader>
                <TableHeader {...header("description")}>Description</TableHeader>
                <TableHeader {...header("code")}>Component</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {sort(rows.filter((r) => scope === "all" || (scope === "shared") === !!r.shared)).map((r) => {
                const code = codeOf(r);
                return (
                  <TableRow key={r.shared ? r.shared.id : r.local.key}>
                    <TableCell data-label="Name">
                      {r.shared ? (
                        <Link href={`#/components/${r.shared.id}`}>{r.shared.name}</Link>
                      ) : r.local.href ? (
                        <Link href={r.local.href}>{r.local.where}</Link>
                      ) : (
                        r.local.where
                      )}
                    </TableCell>
                    <TableCell data-label="Kind">
                      <span className="component-choice">
                        <span className="component-choice__name">{kindLabel(code)}</span>
                        {code.ai && (
                          <Tag size="sm" type="purple">
                            AI
                          </Tag>
                        )}
                      </span>
                    </TableCell>
                    <TableCell data-label="Where">{r.shared ? "Shared" : "Written here"}</TableCell>
                    <TableCell data-label="Description">{r.shared?.description ?? ""}</TableCell>
                    {/* Its first line; the whole component is edited on its page (or in its place). */}
                    <TableCell data-label="Component" className="components-table__code">
                      {/* At most two lines of it (cut off with …). */}
                      <span className="components-table__excerpt">
                        {code.code.split("\n")[0]}
                        {code.code.includes("\n") ? " …" : ""}
                      </span>
                    </TableCell>
                    <RowActions>
                      {(inMenu) => {
                        const btn = rowButtonProps(inMenu);
                        const x = r.shared;
                        if (!x) {
                          const local = r.local;
                          return (
                            <IconButton {...btn} label={`Save ${local.where} as a shared component`} onClick={() => setPromoting(local)}>
                              <Share />
                            </IconButton>
                          );
                        }
                        return (
                          <>
                            <IconButton {...btn}
                              label={`Duplicate ${x.name}`}
                              onClick={() => {
                                // A copy named "Name 2" (then "Name 3", …), like new views.
                                const ts = now();
                                repo
                                  .saveComponent({ ...x, id: newId(), name: nextName(x.name, components.map((t) => t.name)), createdAt: ts, updatedAt: ts })
                                  .catch((e) => setError(errorMessage(e)));
                              }}
                            >
                              <Copy />
                            </IconButton>
                            <IconButton {...btn}
                              label={`Delete ${x.name}`}
                              onClick={() => {
                                setWithFields(false);
                                setDeleting(x);
                              }}
                            >
                              <TrashCan />
                            </IconButton>
                          </>
                        );
                      }}
                    </RowActions>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </FillTable>
      )}
      {promoting && (
        <PromoteComponentModal
          local={promoting.component}
          suggestedName={promoting.where.split(" › ").pop()}
          onClose={() => setPromoting(null)}
          onPromoted={async (c) => {
            setPromoting(null);
            await pickShared(repo, promoting.owner, c, collections, space.id).catch((e) => setError(errorMessage(e)));
          }}
        />
      )}
      {/* Deleting one that fields use: they can go along (an extra checkbox), else it's refused. */}
      <Modal
        open={deleting !== null}
        danger
        size="xs"
        modalHeading={`Delete component “${deleting?.name ?? ""}”?`}
        primaryButtonText="Delete"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={users.length > 0 && !withFields}
        onRequestSubmit={() => remove()}
        onRequestClose={() => setDeleting(null)}
      >
        {users.length === 0 ? (
          <p>No fields use it.</p>
        ) : (
          <>
            <p>Used by {users.join(", ")}.</p>
            <Checkbox
              id="delete-component-fields"
              className="modal-checkbox"
              labelText={users.length === 1 ? "Also delete this field" : `Also delete these ${users.length} fields`}
              checked={withFields}
              onChange={(_, { checked }) => setWithFields(checked)}
            />
          </>
        )}
      </Modal>
    </>
  );
}
