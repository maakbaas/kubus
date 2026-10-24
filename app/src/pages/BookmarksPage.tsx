import { useEffect, useState } from "react";
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
import { NewButton } from "../ui/NewButton";
import { CollectionIcon, CollectionLabel } from "../ui/collectionIcons";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";
import { useTableSort } from "../ui/useTableSort";
import { RowActions, rowButtonProps } from "../ui/RowActions";
import { FillTable } from "../views/TableView";

/** Something that can be bookmarked: one of a collection's views or items. */
interface Target {
  kind: BookmarkKind;
  id: string;
  /** As listed in the picker. */
  text: string;
  /** The bookmark's label in the side nav. */
  label: string;
}

/**
 * All bookmarks as a table (name opens it; what it is: "Note" or "View of Notes"; remove), plus "New bookmark":
 * pick a collection, then one of its views or items.
 */
export function BookmarksPage() {
  const { repo, collections, bookmarks, space } = useStore();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const fail = (e: unknown) => setError(errorMessage(e));
  const { sort, header } = useTableSort<Bookmark, "name" | "kind">({
    name: (b) => b.label,
    kind: (b) => {
      const t = collections.find((c) => c.id === b.collectionId);
      return t ? (b.kind === "view" ? `View of ${t.pluralName}` : t.name) : "";
    },
  });

  return (
    <>
      <PageHeader
        title="Bookmarks"
        subtitle="Views and items in the side nav. Bookmark one with its bookmark icon, or add one here."
        actions={<NewButton label="New bookmark" onClick={() => setAdding(true)} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {bookmarks.length === 0 ? (
        <Tile className="empty-state">
          <p>No bookmarks yet.</p>
        </Tile>
      ) : (
        <FillTable>
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableHeader {...header("name")}>Name</TableHeader>
                <TableHeader {...header("kind")}>Collection</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {sort(bookmarks).map((b) => {
                const collection = collections.find((t) => t.id === b.collectionId);
                return (
                  <TableRow key={b.id}>
                    <TableCell data-label="Name">
                      <Link href={`#${bookmarkPath(b)}`}>{b.label}</Link>
                    </TableCell>
                    <TableCell data-label="Collection">
                      {collection && (
                        <span className="icon-label">
                          <CollectionIcon name={collection.icon} />
                          {/* "Note" for an item, "View of Notes" for a view. */}
                          {b.kind === "view" ? `View of ${collection.pluralName}` : collection.name}
                        </span>
                      )}
                    </TableCell>
                    <RowActions>
                      {(inMenu) => {
                        const btn = rowButtonProps(inMenu);
                        return (
                          <>
                            <IconButton {...btn} label={`Remove bookmark ${b.label}`} onClick={() => repo.removeBookmark(b.targetId, space.id).catch(fail)}>
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
      {adding && <NewBookmarkModal onClose={() => setAdding(false)} onError={fail} />}
    </>
  );
}

function NewBookmarkModal({ onClose, onError }: { onClose(): void; onError(e: unknown): void }) {
  const { repo, spaceCollections, bookmarks, space } = useStore();
  const [collection, setCollection] = useState<Collection | null>(spaceCollections[0] ?? null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target | null>(null);

  // The chosen collection's views and items, minus what is already bookmarked.
  useEffect(() => {
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
  }, [repo, collection, space.id]);

  return (
    <Modal
      open
      size="xs"
      modalHeading="New bookmark"
      className="modal--menus"
      primaryButtonText="Add"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!collection || !target}
      onRequestClose={onClose}
      onRequestSubmit={() => {
        if (!collection || !target) return;
        repo.addBookmark(target.kind, collection.id, target.id, target.label, space.id).then(onClose, onError);
      }}
    >
      <Stack gap={5}>
        <Dropdown<Collection> autoAlign
          size="sm"
          id="bookmark-item"
          titleText="Collection"
          label="Choose a collection"
          items={spaceCollections}
          selectedItem={collection ?? undefined}
          itemToString={(t) => t?.pluralName ?? ""}
          itemToElement={(t) => <CollectionLabel collection={{ ...t, name: t.pluralName }} />}
          renderSelectedItem={(t) => <CollectionLabel collection={{ ...t, name: t.pluralName }} />}
          onChange={({ selectedItem }) => setCollection(selectedItem ?? null)}
        />
        <ComboBox<Target> autoAlign
          size="sm"
          id="bookmark-target"
          titleText="View or item"
          placeholder="Search views and items"
          items={targets}
          selectedItem={target}
          itemToString={(t) => t?.text ?? ""}
          onChange={({ selectedItem }) => setTarget(selectedItem ?? null)}
        />
      </Stack>
    </Modal>
  );
}
