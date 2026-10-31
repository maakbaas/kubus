import { useMemo, useState } from "react";
import {
  IconButton,
  InlineNotification,
  Link,
  Modal,
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
import { bookmarkLabel, bookmarkPath, withViewId, type Bookmark } from "../domain/bookmarks";
import { bookmarkPlace } from "../ui/bookmarkPlace";
import { findTab, isVirtualTab } from "../domain/dashboards";
import { parseStoredDashboardLink, type LinkTarget } from "../domain/linkTargets";
import { useLinks } from "../app/useLinks";
import { useLinkTargets } from "../app/useLinkTargets";
import { LinkTargetInput } from "../ui/LinkTargetInput";
import { NewButton } from "../ui/NewButton";
import { CollectionIcon } from "../ui/collectionIcons";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage } from "../ui/useConfirm";
import { useMountedDialog } from "../ui/useMountedDialog";
import { useTableSort } from "../ui/useTableSort";
import { LIST_MAIN, LIST_TABLE } from "../ui/listTable";
import { RowActions, ROW_BUTTON } from "../ui/RowActions";
import { FillTable } from "../views/TableView";

/**
 * All bookmarks as a table (name opens it; where it is: "Book", "View of Books", "Field of Dune", "View of Health"; remove), plus
 * "New bookmark": any page, searched for by name or link.
 */
export function BookmarksPage() {
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const fail = (e: unknown) => setError(errorMessage(e));

  return (
    <>
      <PageHeader
        title="Bookmarks"
        subtitle="Pages in the side nav: views, items, fields, blocks, dashboards. Bookmark one with its bookmark icon, or add any page here."
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
    kind: (b) => bookmarkPlace(b.link, collections, dashboards)?.text ?? "",
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
                <TableHeader {...header("kind")}>Where</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {sort(bookmarks).map((b) => {
                const of = bookmarkPlace(b.link, collections, dashboards);
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
                      <IconButton {...ROW_BUTTON} label={`Remove bookmark ${b.label}`} onClick={() => repo.removeBookmark(b.link, space.id).catch(onError)}>
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

/**
 * New bookmark: one field, searched as a link is (the Markdown editor's link dialog, LinkTargetInput): a name, a
 * part of one, or a link typed or pasted; its options are every page a link can name that isn't bookmarked yet
 * (a collection, a view, an item under an item view, a field, a block, a dashboard). What was typed is taken as it is
 * when no option was picked (as the link dialog's Apply and a linked block's link take it), checked as the API checks it.
 */
function NewBookmarkModal({ onClose, onError }: { onClose(): void; onError(e: unknown): void }) {
  const open = useMountedDialog();
  const { repo, bookmarks, space } = useStore();
  const links = useLinks();
  const { targetOf } = useLinkTargets();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<LinkTarget | null>(null);
  const [problem, setProblem] = useState<string>();
  const taken = useMemo(() => new Set(bookmarks.map((b) => b.link)), [bookmarks]);
  const offered = (t: LinkTarget) => !taken.has(t.href);

  /** The page to bookmark, or why there is none (the API's words). */
  async function pageOf(): Promise<LinkTarget | string> {
    const t = picked ?? (await targetOf(text.trim()));
    if (!t) return `“${text.trim()}” names no page in this space`;
    return taken.has(t.href) ? "Already bookmarked" : t;
  }

  async function add() {
    const t = await pageOf();
    if (typeof t === "string") return setProblem(t);
    let link = t.href;
    // A dashboard view copied from another space is stored in this space first: a bookmark needs a real one.
    const onDashboard = parseStoredDashboardLink(link);
    if (onDashboard?.viewId) {
      const shown = findTab(await repo.listDashboardViews(onDashboard.dashboardId, space.id), onDashboard.viewId);
      if (shown && isVirtualTab(shown.id)) {
        const stored = (await repo.storeDashboardViews(onDashboard.dashboardId, space.id)).get(shown.id);
        if (stored) link = withViewId(link, onDashboard.viewId, stored);
      }
    }
    await repo.addBookmark(link, bookmarkLabel(t), space.id);
    onClose();
  }

  return (
    <Modal
      open={open}
      size="xs"
      modalHeading="New bookmark"
      className="modal--menus"
      primaryButtonText="Add"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!text.trim()}
      onRequestClose={onClose}
      onRequestSubmit={() => void add().catch(onError)}
    >
      <LinkTargetInput
        id="bookmark-target"
        primaryFocus
        labelText="Page"
        placeholder="A name, or a link: book/dune/details#author"
        invalidText={problem}
        value={text}
        onChange={(next) => {
          setText(next);
          setPicked(null);
          setProblem(undefined);
        }}
        toShown={links.toShown}
        filter={offered}
        onPick={(_, t) => setPicked(t)}
      />
    </Modal>
  );
}
