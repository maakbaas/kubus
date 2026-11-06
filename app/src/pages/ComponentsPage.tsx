import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Accordion, AccordionItem, Checkbox, Dropdown, IconButton, InlineNotification, Link, Modal, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tile } from "@carbon/react";
import { Copy, Share, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { newId, nextName, now } from "../domain/model";
import { COMPONENT_KINDS, componentsUsedIn, componentUses, localComponents, localUsedIn, type Component, type ComponentCode, type LocalComponent } from "../domain/components";
import type { CollectionView } from "../domain/views";
import type { DashboardView } from "../domain/dashboards";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { PromoteComponentModal } from "../ui/PromoteComponentModal";
import { pickShared } from "../ui/promoteLocal";
import { errorMessage } from "../ui/useConfirm";
import { useTableSort } from "../ui/useTableSort";
import { LIST_MAIN, LIST_TABLE } from "../ui/listTable";
import { RowActions, ROW_BUTTON } from "../ui/RowActions";
import { FillTable, useSharedColumns } from "../views/TableView";
import { ShownDialog } from "../ui/ShownDialog";

/** A component's kind as the list shows it (Field, Block, Static), from what its code uses. */
/** Its kind; asking AI makes it a kind of its own ("AI field": only a field can ask AI). */
function kindLabel(x: ComponentCode): string {
  const uses = componentUses(x.code);
  return uses.mixed ? "Mixed: fix it" : x.ai ? "AI field" : COMPONENT_KINDS[uses.kind];
}

const SCOPES = ["all", "shared", "local"] as const;
type Scope = (typeof SCOPES)[number];
const SCOPE_TEXT: Record<Scope, string> = { all: "All components", shared: "Shared", local: "Local" };

/**
 * Sets `--widest` on the element: the button of the Carbon dropdown in it as wide as its widest choice (its text in
 * the button's font, and the button's padding), so it neither changes width with the choice nor cuts one off with "…".
 */
function useWidestChoice(texts: string[]) {
  const key = texts.join("\n");
  // A callback ref: the dropdown is shown only once the list has loaded.
  return useCallback(
    (el: HTMLDivElement | null) => {
      const update = () => {
        const text = el?.querySelector<HTMLElement>(".cds--dropdown-text");
        const context = document.createElement("canvas").getContext("2d");
        if (!el?.isConnected || !text || !context) return;
        const cs = getComputedStyle(text);
        context.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const widest = Math.max(...key.split("\n").map((t) => context.measureText(t).width));
        el.style.setProperty("--widest", `${Math.ceil(widest + parseFloat(cs.paddingInlineStart) + parseFloat(cs.paddingInlineEnd) + 1)}px`);
      };
      update();
      // Measured again once IBM Plex has loaded (until then the text is in a fallback font).
      document.fonts?.ready.then(update);
    },
    [key],
  );
}

/** A row of the list: a shared component, or a local one (written in place) by where it is used. */
type Row = { shared: Component; local?: undefined } | { local: LocalComponent; shared?: undefined };
const codeOf = (r: Row): ComponentCode => (r.shared ? r.shared : r.local.component);
const nameOf = (r: Row) => (r.shared ? r.shared.name : r.local.where);

/**
 * The list of components as a table: shared ones (name opens the editor) and local ones, written
 * in place in a field or block (named by where they are used, which the name links to; "Save as
 * shared component" promotes one). Kind ("AI" for those that ask AI), and the component's start.
 * Shared ones are created and edited on their own page (ComponentEditorPage). Components belong to no space: all are
 * listed, grouped by whether this space uses them ("Used in this space", `componentsUsedIn`), like the Collections page.
 */
export function ComponentsPage() {
  const { repo, collections, components, dashboards, space } = useStore();
  const navigate = useNavigate();
  // null while loading: the list shows once complete, so the local ones of views don't shift it.
  const [views, setViews] = useState<CollectionView[] | null>(null);
  const scopeBox = useWidestChoice(Object.values(SCOPE_TEXT));
  const loadViews = useCallback(() => {
    repo.listAllViews().then(setViews, (e) => console.error("Loading views failed", e));
  }, [repo]);
  useEffect(loadViews, [loadViews]);
  useDataChanges((change) => change.scope === "views" && loadViews());
  // Dashboard tabs, for which components this space's dashboards use.
  const [dashboardViews, setDashboardViews] = useState<DashboardView[] | null>(null);
  const loadDashboardViews = useCallback(() => {
    repo.listAllDashboardViews().then(setDashboardViews, (e) => console.error("Loading dashboard views failed", e));
  }, [repo]);
  useEffect(loadDashboardViews, [loadDashboardViews]);
  useDataChanges((change) => (change.scope === "dashboardViews" || change.scope === "dashboards") && loadDashboardViews());
  const rows = useMemo<Row[]>(
    () => [...components.map((shared) => ({ shared })), ...localComponents(collections, views ?? []).map((local) => ({ local }))],
    [components, collections, views],
  );
  const { sort, header } = useTableSort<Row, "name" | "kind" | "place" | "description" | "code">({
    name: nameOf,
    kind: (r) => kindLabel(codeOf(r)),
    place: (r) => (r.shared ? "Shared" : "Local"),
    description: (r) => r.shared?.description ?? "",
    code: (r) => codeOf(r).code.split("\n")[0],
  });
  const [scope, setScope] = useState<Scope>("all");
  // Every component is listed (they belong to no space), split by whether this space uses it (like the Collections
  // page's "In this space"): a shared one by a field, a block of a view or an item view, or a dashboard tab here; a local
  // one where it is written.
  const used = useMemo(
    () => componentsUsedIn(space.id, { collections, views: views ?? [], dashboards, dashboardViews: dashboardViews ?? [] }),
    [space.id, collections, views, dashboards, dashboardViews],
  );
  const scoped = rows.filter((r) => scope === "all" || (scope === "shared") === !!r.shared);
  const isUsed = (r: Row) => (r.shared ? used.has(r.shared.id) : localUsedIn(r.local, space.id, collections, views ?? []));
  const here = scoped.filter(isUsed);
  const elsewhere = scoped.filter((r) => !isUsed(r));
  const groups = [
    { label: "Used in this space", list: here },
    { label: "Not used in this space", list: elsewhere },
  ].filter((g) => g.list.length > 0);
  const groupsBox = useRef<HTMLDivElement>(null);
  useSharedColumns(groupsBox, elsewhere.length > 0);
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

  const table = (list: Row[]) => (
    <FillTable>
      <Table size="sm" className={LIST_TABLE}>
        <TableHead>
          <TableRow>
            <TableHeader className={LIST_MAIN} {...header("name")}>Name</TableHeader>
            <TableHeader {...header("kind")}>Kind</TableHeader>
            <TableHeader {...header("place")}>Where</TableHeader>
            <TableHeader {...header("description")}>Description</TableHeader>
            <TableHeader {...header("code")}>Component</TableHeader>
            <TableHeader aria-label="Actions" />
          </TableRow>
        </TableHead>
        <TableBody>
          {sort(list).map((r) => {
            const code = codeOf(r);
            return (
              <TableRow key={r.shared ? r.shared.id : r.local.key}>
                <TableCell className={LIST_MAIN}>
                  {r.shared ? (
                    <Link href={`#/components/${r.shared.id}`}>{r.shared.name}</Link>
                  ) : r.local.href ? (
                    <Link href={r.local.href}>{r.local.where}</Link>
                  ) : (
                    r.local.where
                  )}
                </TableCell>
                <TableCell>
                  <span className="component-choice">
                    <span className="component-choice__name">{kindLabel(code)}</span>
                  </span>
                </TableCell>
                <TableCell>{r.shared ? "Shared" : "Local"}</TableCell>
                <TableCell>{r.shared?.description ?? ""}</TableCell>
                {/* Its first line; the whole component is edited on its page (or in its place). */}
                <TableCell className="components-table__code">
                  {/* At most two lines of it (cut off with …). */}
                  <span className="components-table__excerpt">
                    {code.code.split("\n")[0]}
                    {code.code.includes("\n") ? " …" : ""}
                  </span>
                </TableCell>
                <RowActions>
                  {r.shared ? (
                    <>
                      <IconButton {...ROW_BUTTON}
                        label={`Duplicate ${r.shared.name}`}
                        onClick={() => {
                          // A copy named "Name 2" (then "Name 3", …), like new views.
                          const x = r.shared;
                          const ts = now();
                          repo
                            .saveComponent({ ...x, id: newId(), name: nextName(x.name, components.map((t) => t.name)), createdAt: ts, updatedAt: ts })
                            .catch((e) => setError(errorMessage(e)));
                        }}
                      >
                        <Copy />
                      </IconButton>
                      <IconButton {...ROW_BUTTON}
                        label={`Delete ${r.shared.name}`}
                        onClick={() => {
                          setWithFields(false);
                          setDeleting(r.shared);
                        }}
                      >
                        <TrashCan />
                      </IconButton>
                    </>
                  ) : (
                    <IconButton {...ROW_BUTTON} label={`Save ${r.local.where} as a shared component`} onClick={() => setPromoting(r.local)}>
                      <Share />
                    </IconButton>
                  )}
                </RowActions>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </FillTable>
  );

  return (
    <>
      <PageHeader
        title="Components"
        subtitle="Code that computes content and values: field components show one item, block components a block's items, static ones the same everywhere; AI ones are prompts for AI fields. Shared ones are picked by name; the others are written in place, in one field or block."
        actions={<NewButton label="New component" onClick={() => navigate("/components/new")} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {/* Shared ones, those written in place, or both. */}
      {views !== null && dashboardViews !== null && rows.length > 0 && (
        <div className="components-scope" ref={scopeBox}>
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
      {views === null || dashboardViews === null ? null : rows.length === 0 ? (
        <Tile className="empty-state">
          <p>No components yet.</p>
        </Tile>
      ) : (
        <div ref={groupsBox} className={elsewhere.length > 0 ? "table-groups" : undefined}>
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
                      {label} <span className="view-group__count">{list.length}</span>
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
      {promoting && (
        <PromoteComponentModal
          local={promoting.component}
          suggestedName={promoting.where.split(" / ").pop()}
          onClose={() => setPromoting(null)}
          onPromoted={async (c) => {
            setPromoting(null);
            await pickShared(repo, promoting.owner, c, collections, space.id).catch((e) => setError(errorMessage(e)));
          }}
        />
      )}
      {/* Deleting one that fields use: they can go along (an extra checkbox), else it's refused. */}
      <ShownDialog shown={deleting !== null}>
        {(open) => (
          <Modal
            open={open}
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
        )}
      </ShownDialog>
    </>
  );
}
