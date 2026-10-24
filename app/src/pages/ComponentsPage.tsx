import { useState } from "react";
import { useNavigate } from "react-router";
import { Checkbox, IconButton, InlineNotification, Link, Modal, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tile } from "@carbon/react";
import { Copy, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { newId, nextName, now } from "../domain/model";
import type { Component } from "../domain/components";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";
import { RowActions, rowButtonProps } from "../ui/RowActions";
import { FillTable } from "../views/TableView";

/**
 * The list of components as a table: name (opens the editor) and the component's start. Creating
 * and editing happen on their own page (ComponentEditorPage).
 */
export function ComponentsPage() {
  const { repo, collections, components } = useStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  // The component being deleted, and whether the fields using it go too.
  const [deleting, setDeleting] = useState<Component | null>(null);
  const [withFields, setWithFields] = useState(false);
  const users = deleting
    ? collections.flatMap((t) => t.fields.filter((f) => f.kind === "component" && f.componentId === deleting.id).map((f) => `“${f.name}” of ${t.name}`))
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
        subtitle="Markdown with {{ JavaScript }} sections over $variables. Add a field of type “Component” to a collection and map each variable to one of its fields."
        actions={<NewButton label="New component" onClick={() => navigate("/components/new")} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {components.length === 0 ? (
        <Tile className="empty-state">
          <p>No components yet.</p>
        </Tile>
      ) : (
        <FillTable>
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Component</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {components.map((x) => (
                <TableRow key={x.id}>
                  <TableCell data-label="Name">
                    <Link href={`#/components/${x.id}`}>{x.name}</Link>
                  </TableCell>
                  {/* Its first line; the whole component is edited on its page. */}
                  <TableCell data-label="Component" className="components-table__code">
                    {/* At most two lines of it (cut off with …). */}
                    <span className="components-table__excerpt">
                      {x.code.split("\n")[0]}
                      {x.code.includes("\n") ? " …" : ""}
                    </span>
                  </TableCell>
                  <RowActions>
                    {(inMenu) => {
                      const btn = rowButtonProps(inMenu);
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
              ))}
            </TableBody>
          </Table>
        </FillTable>
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
