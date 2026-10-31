import { useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button, InlineNotification } from "@carbon/react";
import { Launch, Link as LinkIcon } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { useLinks } from "../app/useLinks";
import { blockCollections, findCollection } from "../domain/backlinks";
import { withComputed } from "../domain/components";
import { findTab, type Dashboard, type DashboardView } from "../domain/dashboards";
import { itemViewOf, type ItemView } from "../domain/fieldLayout";
import { blockLinkKey, findLinkedBlock, linkProblem, parseBlockLink, type BlockLink } from "../domain/linkedBlocks";
import { fieldValue, itemLabel, pickableFields, type Collection, type Item } from "../domain/model";
import { isRemote } from "../domain/sources";
import { NOTHING_COLLAPSED, pageFiltersFor, type Collapsed, type CollectionView, type ViewBlock } from "../domain/views";
import type { FilterRule } from "../domain/query";
import { LinkTargetInput } from "../ui/LinkTargetInput";
import { ViewField } from "../pages/ItemPage";
import { errorMessage } from "../ui/useConfirm";
import { refLabelOf, useReferenceOptions } from "../ui/useReferenceOptions";
import { blockType, normalizeBlock } from "./index";
import { useBlockName } from "./BlockListEditor";
import { LinkChain } from "./linkChain";
import { BlockView } from "./BlockView";
import { useBacklinkData } from "./useBacklinks";
import { useCollectionData } from "./useCollectionData";
import { ListData } from "./useListData";
import { defineBlockType, type BlockOptionsProps, type BlockPlace, type BlockProps, type PageItem } from "./registry";

// A linked block (domain/linkedBlocks.ts): shows another block as it is set up where it is (its collection, filter,
// fields, type and options, and that page's filter and item), read-only here: its settings are changed on the original.
// Values are edited in place where the original's page lets them be.

export interface LinkedBlockOptions {
  /** The linked block, in the stored form of links (`#/collections/…?block=`, `#/dashboards/…?block=`); "" = none yet. */
  href: string;
  /** The linked block's name when it was chosen or last shown: this block's name while it has no title of its own. */
  name?: string;
}

function normalizeOptions(raw: unknown): LinkedBlockOptions {
  const o = raw && typeof raw === "object" ? (raw as Partial<LinkedBlockOptions>) : {};
  const options: LinkedBlockOptions = { href: typeof o.href === "string" ? o.href : "" };
  if (typeof o.name === "string" && o.name) options.name = o.name;
  return options;
}

function LinkedBlockView({ options, onOptions }: BlockProps<LinkedBlockOptions>) {
  const chain = useContext(LinkChain);
  const link = useMemo(() => parseBlockLink(options.href), [options.href]);
  const problem = linkProblem(link, options.href, chain);
  // The original's name, kept for this block's header (it has no title of its own); only by the outermost block, which stores it.
  const onName = useCallback(
    (name: string) => {
      if (chain.length === 0 && name !== options.name) onOptions({ ...options, name });
    },
    [chain.length, options, onOptions],
  );
  // Not linked yet: its Block settings, where the link is chosen, open by themselves (`unset`); here linkProblem says so.
  if (problem || !link) return <Notice text={problem ?? ""} />;
  return (
    <LinkChain.Provider value={[...chain, blockLinkKey(link)]}>
      {link.place === "collection" ? (
        <FromView link={link} onName={onName} />
      ) : link.place === "item" ? (
        <ItemOf link={link}>{(collection, item) => <FromItem collection={collection} item={item} link={link} onName={onName} />}</ItemOf>
      ) : link.place === "field" ? (
        <ItemOf link={link}>{(collection, item) => <LinkedField collection={collection} item={item} fieldId={link.fieldId} onName={onName} />}</ItemOf>
      ) : (
        <FromDashboard link={link} onName={onName} />
      )}
    </LinkChain.Provider>
  );
}

const Notice = ({ text }: { text: string }) => <InlineNotification kind="info" lowContrast hideCloseButton title={text} />;
const GONE = "The linked block is gone (deleted, or not in this space).";

type FromProps<P extends BlockLink["place"]> = { link: Extract<BlockLink, { place: P }>; onName(name: string): void };

/** A block of a collection view, under the view's filter. */
function FromView({ link, onName }: FromProps<"collection">) {
  const { repo, space, collections } = useStore();
  const collection = collections.find((c) => c.id === link.collectionId);
  const [views, setViews] = useState<CollectionView[] | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    repo.listViews(link.collectionId, space.id).then(setViews, (e) => setError(errorMessage(e)));
  }, [repo, link.collectionId, space.id]);
  useEffect(load, [load]);
  useDataChanges((change) => change.scope === "views" && change.collectionId === link.collectionId && load());
  if (error) return <Notice text={error} />;
  if (!views) return null;
  const named = link.viewId ? views.find((v) => v.id === link.viewId) : undefined;
  const found = collection && findLinkedBlock(views, (v) => v.blocks, named, views.find((v) => v.isDefault) ?? views[0], link.blockId);
  if (!collection || !found) return <Notice text={GONE} />;
  return <Original home={collection} block={found.block} place="collection" page={null} viewFilters={found.view.filters} editable={found.view.editable} onName={onName} />;
}

/** A block of a dashboard view (in the shown space: its own views, or copies of another space's), under the view's filter. */
function FromDashboard({ link, onName }: FromProps<"dashboard">) {
  const { repo, space, dashboards, collections } = useStore();
  const dashboard: Dashboard | undefined = dashboards.find((d) => d.id === link.dashboardId);
  const [tabs, setTabs] = useState<DashboardView[] | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    repo.listDashboardViews(link.dashboardId, space.id).then(setTabs, (e) => setError(errorMessage(e)));
  }, [repo, link.dashboardId, space.id]);
  useEffect(load, [load]);
  useDataChanges((change) => change.scope === "dashboardViews" && change.dashboardId === link.dashboardId && load());
  if (error) return <Notice text={error} />;
  if (!tabs) return null;
  const named = link.viewId ? findTab(tabs, link.viewId) : undefined;
  const found = dashboard && findLinkedBlock(tabs, (v) => v.blocks, named, tabs.find((v) => v.isDefault) ?? tabs[0], link.blockId);
  // As the dashboard shows it: its first collection still there (several are merged by normalizeBlock).
  const home = found && blockCollections(found.block, collections)[0];
  if (!found || !home) return <Notice text={GONE} />;
  return <Original home={home} block={found.block} place="dashboard" page={null} viewFilters={found.view.filters} editable={found.view.editable} onName={onName} />;
}

/** The item a link names (of an item's page, or one of its fields), read and kept current, given to `children`. */
function ItemOf({ link, children }: { link: { collectionId: string; itemId: string }; children(collection: Collection, item: Item): ReactNode }) {
  const { repo, collections } = useStore();
  const collection = collections.find((c) => c.id === link.collectionId);
  const [item, setItem] = useState<Item | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    if (!collection || isRemote(collection)) return;
    repo.getItem(collection, link.itemId).then(setItem, (e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, collection?.id, link.itemId]);
  useEffect(load, [load]);
  useDataChanges((change) => change.scope === "items" && change.collectionId === link.collectionId && (!change.itemId || change.itemId === link.itemId) && load());
  if (collection && isRemote(collection)) return <Notice text="A remote row's page can't be linked." />;
  if (error) return <Notice text={error} />;
  if (item === undefined && collection) return null;
  if (!collection || !item) return <Notice text={GONE} />;
  return <>{children(collection, item)}</>;
}

/**
 * One field of an item, its value as the item's page shows it (a component field computed), read-only: it is changed on
 * the item. Its name is the block's ("Dune / Author", as bookmarks name a field).
 */
function LinkedField({ collection, item, fieldId, onName }: { collection: Collection; item: Item; fieldId: string; onName(name: string): void }) {
  const { components } = useStore();
  const refs = useReferenceOptions(collection);
  const shown = useMemo(() => withComputed(collection, [item], components, refLabelOf(refs))[0], [collection, item, components, refs]);
  const field = pickableFields(collection).find((f) => f.id === fieldId);
  const name = field ? `${itemLabel(collection, shown)} / ${field.name}` : "";
  useEffect(() => {
    if (name) onName(name);
  }, [name, onName]);
  if (!field) return <Notice text={GONE} />;
  // Without the field's name (the block's header says it), as an item page shows a field without its name.
  return (
    <div className="item-field--no-label">
      <ViewField field={field} value={fieldValue(shown, field)} refs={refs} onEdit={ignore} onSave={ignore} readOnly fixed labelHidden itemId={item.id} />
    </div>
  );
}

/** A block of an item's page (under the item view it names, else the item's own), with the item as its page's item. */
function FromItem({ collection, item, link, onName }: { collection: Collection; item: Item } & FromProps<"item">) {
  const { components, collections } = useStore();
  const refs = useReferenceOptions(collection);
  const page = useMemo<PageItem>(() => {
    const refLabel = refLabelOf(refs);
    return { collection, item: withComputed(collection, [item], components, refLabel)[0], refLabel };
  }, [collection, item, components, refs]);
  const views = collection.itemViews;
  const named = link.viewId ? views.find((v) => v.id === link.viewId) : undefined;
  const found = findLinkedBlock<ItemView>(views, (v) => v.layout.blocks, named, itemViewOf(collection) ?? undefined, link.blockId);
  if (!found) return <Notice text={GONE} />;
  const layout = found.view.layout;
  // The page's filter for all its blocks applies with more than one block listing items (as on the page itself).
  const listing = layout.blocks.filter((b) => blockType(b.kind).uses(b.options, components).query).length;
  const home = findCollection(collections, found.block.collectionId ?? collection.id);
  if (!home) return <Notice text={GONE} />;
  const filters = listing > 1 ? pageFiltersFor(home, layout.filters) : null;
  return <Original home={home} block={found.block} place="item" page={page} viewFilters={filters} editable={layout.editable} onName={onName} />;
}

interface OriginalProps {
  home: Collection;
  block: ViewBlock;
  place: BlockPlace;
  page: PageItem | null;
  viewFilters: FilterRule[] | null;
  editable: boolean;
  onName(name: string): void;
}

/** The original block, without its header (this block's is shown) and read-only: what would change it goes nowhere. */
function Original(props: OriginalProps) {
  const name = useBlockName()(props.block);
  const { onName } = props;
  useEffect(() => onName(name), [name, onName]);
  if (props.home.virtual === "backlinks" && props.page) return <BacklinksOriginal {...props} page={props.page} />;
  // A list field's entries are made from the items in the shared cache, as on the original's page.
  if (props.home.listOf) return <ListData list={props.home}>{(data) => <OriginalView {...props} data={data} />}</ListData>;
  return <NativeOriginal {...props} />;
}

function NativeOriginal(props: OriginalProps) {
  const data = useCollectionData(props.home);
  return <OriginalView {...props} data={data} />;
}

function BacklinksOriginal(props: OriginalProps & { page: PageItem }) {
  const data = useBacklinkData(props.page);
  return <OriginalView {...props} data={data} />;
}

const ignore = () => {};

function OriginalView({ home, block, place, page, viewFilters, editable, data }: OriginalProps & { data: ReturnType<typeof useCollectionData> }) {
  const { collections } = useStore();
  const normalized = useMemo(() => ({ ...normalizeBlock(home, block, place === "dashboard" ? collections : undefined), hideHeader: true as const }), [home, block, place, collections]);
  // Its groups collapse here, for the time being (they are stored with the original's page).
  const [collapsed, setCollapsed] = useState<Collapsed>(NOTHING_COLLAPSED);
  const [error, setError] = useState<string>();
  return (
    <>
      {error && <InlineNotification kind="error" lowContrast title={error} onClose={() => setError(undefined)} />}
      <BlockView
        collection={home}
        data={data}
        block={normalized}
        viewFilters={viewFilters}
        search=""
        place={place}
        page={page}
        editable={editable}
        headerHidden
        collapsed={collapsed}
        onCollapse={setCollapsed}
        onChange={ignore}
        onSet={ignore}
        onError={setError}
      />
    </>
  );
}

/** The link, written by name like any link (`books/reading-list#chart`, `book/dune#chart`, `dashboards/health#chart`), and the original. */
function LinkedBlockSettings({ options, onChange }: Pick<BlockOptionsProps<LinkedBlockOptions>, "options" | "onChange">) {
  const id = useId();
  const links = useLinks();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string>();
  // The stored link shown by name (as it is when it names nothing any more).
  useEffect(() => {
    let current = true;
    links.toShown(options.href).then((shown) => current && setText(shown));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.href]);
  /** Stores what was typed or picked when it names a block; says so when it doesn't. */
  const apply = async (value: string) => {
    if (!value.trim()) return setProblem(undefined);
    const stored = await links.toStored(value.trim());
    if (!parseBlockLink(stored)) return setProblem("Not a block or a field: link to a block of a view, an item's page or a dashboard (…#block), or to an item's field (book/dune#author).");
    setProblem(undefined);
    if (stored !== options.href) onChange({ href: stored });
  };
  return (
    <div className="linked-block-settings">
      <LinkTargetInput
        id={`${id}-href`}
        labelText="Linked block"
        placeholder="books/reading-list#chart, book/dune#author"
        helperText="Shown as it is set up there: its settings are changed on the original."
        invalidText={problem}
        value={text}
        onChange={(value) => {
          setText(value);
          setProblem(undefined);
        }}
        // A pick is applied at once, what was typed once the field is left (or Enter).
        onPick={(value) => void apply(value)}
        onCommit={() => void apply(text)}
        toShown={links.toShown}
      />
      {options.href && (
        <Button kind="tertiary" size="sm" renderIcon={Launch} onClick={() => links.open(options.href, "here").catch((e) => setProblem(errorMessage(e)))}>
          Open original
        </Button>
      )}
    </div>
  );
}

export const linkedBlock = defineBlockType<LinkedBlockOptions>({
  kind: "linked",
  label: "Linked block",
  icon: LinkIcon,
  defaultOptions: () => ({ href: "" }),
  normalizeOptions,
  uses: () => ({ query: false, groups: false, fields: null, inheritsCollection: true }),
  unset: (options) => !options.href.trim(),
  View: LinkedBlockView,
  OptionsEditor: LinkedBlockSettings,
});
