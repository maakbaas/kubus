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
import { bookmarkPath, type BookmarkKind } from "../domain/bookmarks";
import { untitledLabel, type ObjectType } from "../domain/model";
import { NewButton } from "../ui/NewButton";
import { TypeIcon, ObjectTypeLabel } from "../ui/typeIcons";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";
import { RowActions, rowButtonProps } from "../ui/RowActions";
import { FillTable } from "../views/TableView";

/** Something that can be bookmarked: one of a type's views or objects. */
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
 * pick a type, then one of its views or objects.
 */
export function BookmarksPage() {
  const { repo, types, bookmarks } = useStore();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const fail = (e: unknown) => setError(errorMessage(e));

  return (
    <>
      <PageHeader
        title="Bookmarks"
        subtitle="Views and objects in the side nav. Bookmark one with its bookmark icon, or add one here."
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
                <TableHeader>Name</TableHeader>
                <TableHeader>Type</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {bookmarks.map((b) => {
                const type = types.find((t) => t.id === b.typeId);
                return (
                  <TableRow key={b.id}>
                    <TableCell data-label="Name">
                      <Link href={`#${bookmarkPath(b)}`}>{b.label}</Link>
                    </TableCell>
                    <TableCell data-label="Type">
                      {type && (
                        <span className="icon-label">
                          <TypeIcon name={type.icon} />
                          {/* "Note" for an object, "View of Notes" for a view. */}
                          {b.kind === "view" ? `View of ${type.pluralName}` : type.name}
                        </span>
                      )}
                    </TableCell>
                    <RowActions>
                      {(inMenu) => {
                        const btn = rowButtonProps(inMenu);
                        return (
                          <>
                            <IconButton {...btn} label={`Remove bookmark ${b.label}`} onClick={() => repo.removeBookmark(b.targetId).catch(fail)}>
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
  const { repo, types, bookmarks } = useStore();
  const [type, setType] = useState<ObjectType | null>(types[0] ?? null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState<Target | null>(null);

  // The chosen type's views and objects, minus what is already bookmarked.
  useEffect(() => {
    setTarget(null);
    if (!type) return setTargets([]);
    let cancelled = false;
    Promise.all([repo.listViews(type.id), repo.listLabels(type)]).then(([views, labels]) => {
      if (cancelled) return;
      const taken = new Set(bookmarks.map((b) => b.targetId));
      setTargets(
        [
          ...views.map((v): Target => ({ kind: "view", id: v.id, text: `View: ${v.name}`, label: `${type.pluralName} / ${v.name}` })),
          ...labels.map((e): Target => {
            const label = e.label ?? untitledLabel(type);
            return { kind: "object", id: e.id, text: label, label };
          }),
        ].filter((t) => !taken.has(t.id)),
      );
    }, onError);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, type]);

  return (
    <Modal
      open
      size="xs"
      modalHeading="New bookmark"
      className="modal--menus"
      primaryButtonText="Add"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!type || !target}
      onRequestClose={onClose}
      onRequestSubmit={() => {
        if (!type || !target) return;
        repo.addBookmark(target.kind, type.id, target.id, target.label).then(onClose, onError);
      }}
    >
      <Stack gap={5}>
        <Dropdown<ObjectType> autoAlign
          size="sm"
          id="bookmark-object"
          titleText="Type"
          label="Choose a type"
          items={types}
          selectedItem={type ?? undefined}
          itemToString={(t) => t?.pluralName ?? ""}
          itemToElement={(t) => <ObjectTypeLabel type={{ ...t, name: t.pluralName }} />}
          renderSelectedItem={(t) => <ObjectTypeLabel type={{ ...t, name: t.pluralName }} />}
          onChange={({ selectedItem }) => setType(selectedItem ?? null)}
        />
        <ComboBox<Target> autoAlign
          size="sm"
          id="bookmark-target"
          titleText="View or object"
          placeholder="Search views and objects"
          items={targets}
          selectedItem={target}
          itemToString={(t) => t?.text ?? ""}
          onChange={({ selectedItem }) => setTarget(selectedItem ?? null)}
        />
      </Stack>
    </Modal>
  );
}
