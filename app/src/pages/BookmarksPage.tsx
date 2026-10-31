import { useEffect, useMemo, useState } from "react";
import {
  ComboBox,
  Dropdown,
  IconButton,
  InlineNotification,
  Link,
  Modal,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tile,
} from "@carbon/react";
import { TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { bookmarkPath, type Bookmark, type BookmarkKind } from "../domain/bookmarks";
import { untitledLabel, type Collection } from "../domain/model";
import { dashboardIcon, isVirtualTab, type Dashboard } from "../domain/dashboards";
import { NewButton } from "../ui/NewButton";
import { CollectionIcon, CollectionLabel } from "../ui/collectionIcons";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";
import { useMountedDialog } from "../ui/useMountedDialog";
import { useTableSort } from "../ui/useTableSort";
import { LIST_MAIN, LIST_TABLE } from "../ui/listTable";
import { RowActions, ROW_BUTTON } from "../ui/RowActions";
import { FillTable } from "../views/TableView";

/** What the New bookmark dialog picks first: a collection (its views and items) or a dashboard (its tabs). */
interface Owner {
  id: string;
  name: string;
  icon: string | null;
  collection?: Collection;
  dashboard?: Dashboard;
}

/** Something that can be bookmarked: one of a collection's views or items, or a dashboard's tab. */
interface Target {
  kind: BookmarkKind;
  id: string;
  /** As listed in the picker. */
  text: string;
  /** The bookmark's label in the side nav. */
  label: string;
}

/** What a bookmark is of, as the table says it: "Note" for an item, "View of Notes" for a view, "Tab of Health" for a dashboard's tab. */
function bookmarkOf(b: Bookmark, collections: Collection[], dashboards: Dashboard[]): { icon: string | null; text: string } | null {
  if (b.kind === "dashboard") {
    const d = dashboards.find((x) => x.id === b.dashboardId);
    return d ? { icon: dashboardIcon(d), text: `Tab of ${d.name}` } : null;
  }
  const t = collections.find((c) => c.id === b.collectionId);
  return t ? { icon: t.icon, text: b.kind === "view" ? `View of ${t.pluralName}` : t.name } : null;
}

/**
 * All bookmarks as a table (name opens it; what it is: "Note", "View of Notes" or "Tab of Health"; remove), plus
 * "New bookmark": pick a collection or dashboard, then one of its views, items or tabs.
 */
export function BookmarksPage() {
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const fail = (e: unknown) => setError(errorMessage(e));

  return (
    <>
      <PageHeader
        title="Bookmarks"
        subtitle="Views, items and dashboard tabs in the side nav. Bookmark one with its bookmark icon, or add one here."
        actions={<NewButton label="New bookmark" onClick={() => setAdding(true)} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      <BookmarksTable onError={fail} />
      {adding && <NewBookmarkModal onClose={() => setAdding(false)} onError={fail} />}
    </>
  );
}

/** The space's bookmarks as a table (name opens it; what it is; remove): the Bookmarks page's and the Home page's. */
export function BookmarksTable({ onError }: { onError(e: unknown): void }) {
  const { repo, collections, dashboards, bookmarks, space } = useStore();
  const { sort, header } = useTableSort<Bookmark, "name" | "kind">({
    name: (b) => b.label,
    kind: (b) => bookmarkOf(b, collections, dashboards)?.text ?? "",
  });
  return (
    <>
      {bookmarks.length === 0 ? (
        <Tile className="empty-state">
          <p>No bookmarks yet.</p>
        </Tile>
      ) : (
        <FillTable>
          <Table size="sm" className={LIST_TABLE}>
            <TableHead>
              <TableRow>
                <TableHeader className={LIST_MAIN} {...header("name")}>Name</TableHeader>
                <TableHeader {...header("kind")}>{bookmarks.some((b) => b.kind === "dashboard") ? "Collection or dashboard" : "Collection"}</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {sort(bookmarks).map((b) => {
                const of = bookmarkOf(b, collections, dashboards);
                return (
                  <TableRow key={b.id}>
                    <TableCell className={LIST_MAIN}>
                      <Link href={`#${bookmarkPath(b)}`}>{b.label}</Link>
                    </TableCell>
                    <TableCell>
                      {of && (
                        <span className="icon-label">
                          <CollectionIcon name={of.icon} />
                          <span className="icon-label__text">{of.text}</span>
                        </span>
                      )}
                    </TableCell>
                    <RowActions>
                      <IconButton {...ROW_BUTTON} label={`Remove bookmark ${b.label}`} onClick={() => repo.removeBookmark(b.targetId, space.id).catch(onError)}>
                        <TrashCan />
                      </IconButton>
                    </RowActions>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </FillTable>
      )}
    </>
  );
}

function NewBookmarkModal({ onClose, onError }: { onClose(): void; onError(e: unknown): void }) {
  const open = useMountedDialog();
  const { repo, spaceCollections, spaceDashboards, bookmarks, space } = useStore();
  // The collections, then the dashboards, of the space.
  const owners = useMemo<Owner[]>(
    () => [
      ...spaceCollections.map((c): Owner => ({ id: c.id, name: c.pluralName, icon: c.icon, collection: c })),
      ...spaceDashboards.map((d): Owner => ({ id: d.id, name: d.name, icon: dashboardIcon(d), dashboard: d })),
    ],
    [spaceCollections, spaceDashboards],
  );
  const [owner, setOwner] = useState<Owner | null>(owners[0] ?? null);
  const collection = owner?.collection ?? null;
  const dashboard = owner?.dashboard ?? null;
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target | null>(null);

  // A dashboard's tabs in this space (virtual copies included: stored when bookmarked), minus what is already bookmarked.
  useEffect(() => {
    if (!dashboard) return;
    setTarget(null);
    let cancelled = false;
    repo.listDashboardViews(dashboard.id, space.id).then((views) => {
      if (cancelled) return;
      const taken = new Set(bookmarks.map((b) => b.targetId));
      setTargets(views.filter((v) => !taken.has(v.id)).map((v): Target => ({ kind: "dashboard", id: v.id, text: `Tab: ${v.name}`, label: `${dashboard.name} / ${v.name}` })));
    }, onError);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, dashboard, space.id]);

  // The chosen collection's views and items, minus what is already bookmarked.
  useEffect(() => {
    if (dashboard) return;
    setTarget(null);
    if (!collection) return setTargets([]);
    let cancelled = false;
    Promise.all([repo.listViews(collection.id, space.id), repo.listLabels(collection)]).then(([views, labels]) => {
      if (cancelled) return;
      const taken = new Set(bookmarks.map((b) => b.targetId));
      setTargets(
        [
          ...views.map((v): Target => ({ kind: "view", id: v.id, text: `View: ${v.name}`, label: `${collection.pluralName} / ${v.name}` })),
          ...labels.filter((e) => e.spaceId === space.id).map((e): Target => {
            const label = e.label ?? untitledLabel(collection);
            return { kind: "item", id: e.id, text: label, label };
          }),
        ].filter((t) => !taken.has(t.id)),
      );
    }, onError);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, collection, dashboard, space.id]);

  async function add(owner: Owner, target: Target) {
    let id = target.id;
    // A virtual tab (a copy of another space's) is stored in this space first: a bookmark needs a real one.
    if (owner.dashboard && isVirtualTab(id)) id = (await repo.storeDashboardViews(owner.id, space.id)).get(id) ?? id;
    await repo.addBookmark(target.kind, owner.id, id, target.label, space.id);
  }

  return (
    <Modal
      open={open}
      size="xs"
      modalHeading="New bookmark"
      selectorPrimaryFocus=".cds--list-box__field"
      className="modal--menus"
      primaryButtonText="Add"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!owner || !target}
      onRequestClose={onClose}
      onRequestSubmit={() => {
        if (!owner || !target) return;
        add(owner, target).then(onClose, onError);
      }}
    >
      <Stack gap={5}>
        <Dropdown<Owner> autoAlign
          size="sm"
          id="bookmark-item"
          titleText={spaceDashboards.length > 0 ? "Collection or dashboard" : "Collection"}
          label={spaceDashboards.length > 0 ? "Choose a collection or dashboard" : "Choose a collection"}
          items={owners}
          selectedItem={owner ?? undefined}
          itemToString={(t) => t?.name ?? ""}
          itemToElement={(t) => <CollectionLabel collection={t} />}
          renderSelectedItem={(t) => <CollectionLabel collection={t} />}
          onChange={({ selectedItem }) => setOwner(selectedItem ?? null)}
        />
        <ComboBox<Target> autoAlign
          size="sm"
          id="bookmark-target"
          titleText={dashboard ? "Tab" : "View or item"}
          placeholder={dashboard ? "Search tabs" : "Search views and items"}

          items={targets}
          selectedItem={target}
          itemToString={(t) => t?.text ?? ""}
          onChange={({ selectedItem }) => setTarget(selectedItem ?? null)}
        />
      </Stack>
    </Modal>
  );
}
