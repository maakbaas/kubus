import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Accordion, AccordionItem, Checkbox, ClickableTile, Select, SelectItem, Slider } from "@carbon/react";
import { Grid as GridIcon } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { fileIdFromSrc } from "../domain/files";
import { itemLabel, fieldValue, pickableFields, type FieldDef, type Item, type Collection } from "../domain/model";
import type { FieldLayout } from "../domain/fieldLayout";
import { outputOf, type Component } from "../domain/components";
import { HtmlFrame } from "../ui/ComponentValue";
import { Highlight } from "../ui/Highlight";
import { MarkdownView } from "../ui/MarkdownView";
import { useFileUrl } from "../ui/images";
import { isEmptyValue, isGrouped } from "../domain/query";
import { itemLinkProps, FieldCell } from "./cells";
import type { RefOptions } from "../ui/useReferenceOptions";
import { defineBlockType, type BlockOptionsProps, type BlockProps, type ItemActions } from "./registry";

/** Card options: which field is the cover, and the cards' shape (the fields on a card are the block's). */
export interface CardOptions {
  /** Field shown as the card's cover: an image, or a markdown field rendered in its place; null = none. */
  coverFieldId: string | null;
  /** Target card width in rem (CARD_WIDTH range): rows get the column count that comes closest. */
  cardWidth: number;
  /**
   * Shape of the cover area: a fixed width:height ratio (the image is shown whole inside it), or
   * "auto" = the average ratio of the collection's cover images, filled (cropping what differs).
   */
  coverRatio: CoverRatio;
  /** Show the item's title on the card. With no title and no fields a card is just its cover. */
  showTitle: boolean;
  /** In a narrow pane (one card per row): a list, each card's cover beside its title and fields. */
  listNarrow: boolean;
}

type CoverRatio = "auto" | "1:1" | "3:2" | "2:3" | "16:9";
const COVER_RATIOS: { value: CoverRatio; text: string }[] = [
  { value: "auto", text: "Automatic" },
  { value: "1:1", text: "Square (1:1)" },
  { value: "3:2", text: "Landscape (3:2)" },
  { value: "16:9", text: "Wide (16:9)" },
  { value: "2:3", text: "Portrait (2:3)" },
];
/** Ratio used for "auto" until the first image has loaded. */
const FALLBACK_RATIO = 4 / 3;
const ratioOf = (r: Exclude<CoverRatio, "auto">) => {
  const [w, h] = r.split(":").map(Number);
  return w / h;
};
/** Card width slider range, in rem. */
const CARD_WIDTH = { min: 8, max: 32, step: 1, initial: 16 };

const imageFields = (collection: Collection) => collection.fields.filter((f) => f.kind === "image");
/** What a cover shows, by its field: an image, rendered Markdown or HTML; null = can't be a cover. */
function coverKind(field: FieldDef | undefined, components: Component[]): "image" | "url" | "markdown" | "html" | null {
  if (!field) return null;
  if (field.kind === "image") return "image";
  if (field.kind === "markdown") return "markdown";
  if (field.kind === "html") return "html";
  if (field.kind !== "component") return null;
  const output = outputOf(field, components);
  return output === "image" ? "url" : output === "markdown" || output === "html" ? output : null;
}
/** Fields that can be a card's cover: images, Markdown and HTML (rendered as the cover), and components giving any of them. */
const coverFields = (collection: Collection, components: Component[]) => collection.fields.filter((f) => coverKind(f, components) !== null);

/** Shape and average colour of each cover image, per file id, for the session. */
const measured = new Map<string, { ratio: number; tint: string | null }>();

/** Side of the downscaled copy the average colour is computed from. */
const SAMPLE = 32;

/**
 * The image's average colour, or null if unreadable. It is drawn at SAMPLE × SAMPLE and the
 * pixels are averaged: browsers don't average when shrinking to a single pixel, they sample a
 * few (often near a corner), which can turn a dark image's colour white.
 */
function averageColor(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SAMPLE;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const data = g.getImageData(0, 0, SAMPLE, SAMPLE).data;
    let r = 0;
    let gr = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // ignore transparent pixels
      r += data[i];
      gr += data[i + 1];
      b += data[i + 2];
      n++;
    }
    if (n === 0) return null;
    return `rgb(${Math.round(r / n)} ${Math.round(gr / n)} ${Math.round(b / n)})`;
  } catch {
    return null;
  }
}

/**
 * A card's cover image. It reports its natural width:height ratio once loaded (for "auto"), and
 * fills the area around it (the image is shown whole) with its own average colour, mixed with
 * the theme's layer colour: a light tint in light themes, a dark one in dark themes.
 */
function CardCover({ fileId: ownFileId, src: srcProp, onRatio }: { fileId?: string; src?: string; onRatio(key: string, ratio: number): void }) {
  // A component's result may name a stored file (`files/<sha256>`): then it is that file.
  const fileId = ownFileId ?? (srcProp ? fileIdFromSrc(srcProp) ?? undefined : undefined);
  const src = fileId ? undefined : srcProp;
  const fileUrl = useFileUrl(fileId ?? null);
  // A stored image, or one by URL (a component's result); measured under its id or URL.
  const url = src ?? fileUrl;
  const key = fileId ?? src ?? "";
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [key]);
  // Files are immutable (content-addressed), so what was measured once holds for the session:
  // a cover seen before gets its tint and shape immediately.
  const [tint, setTint] = useState<string | null>(() => measured.get(key)?.tint ?? null);
  useEffect(() => {
    const known = measured.get(key);
    if (known) {
      setTint(known.tint);
      onRatio(key, known.ratio);
    }
  }, [key, onRatio]);
  return (
    <div className="item-card__cover" style={tint ? ({ "--cover-tint": tint } as CSSProperties) : undefined}>
      {url && src !== undefined && failed ? (
        <span className="image-missing">Image not found</span>
      ) : (
        url && (
          <img
            src={url}
            alt=""
            onError={() => setFailed(true)}
            onLoad={(e) => {
              const img = e.currentTarget;
              // Measured already (the same image on another card): just take its tint.
              const known = measured.get(key);
              if (known) return setTint(known.tint);
              if (img.naturalWidth === 0 || img.naturalHeight === 0) return;
              const m = { ratio: img.naturalWidth / img.naturalHeight, tint: averageColor(img) };
              measured.set(key, m);
              onRatio(key, m.ratio);
              setTint(m.tint);
            }}
          />
        )
      )}
    </div>
  );
}

interface ItemCardProps {
  collection: Collection;
  item: Item;
  options: CardOptions;
  /** Labels and empty fields (the block's layout); a card hides its empty fields itself. */
  layout: FieldLayout;
  /** The fields shown on every card (but the cover). */
  shown: FieldDef[];
  kind: ReturnType<typeof coverKind>;
  refs: RefOptions;
  search: string;
  actions: ItemActions;
  onRatio(key: string, ratio: number): void;
  /** Shown as a list row: the cover beside the text (listNarrow, in a one-column pane). */
  listed: boolean;
}

/** One item's card. Memoized: it isn't rendered again unless its item or the view's settings changed. */
const ItemCard = memo(function ItemCard({ collection, item, options, layout, shown, kind, refs, search, actions, onRatio, listed }: ItemCardProps) {
  const cover = options.coverFieldId ? item.values[options.coverFieldId] : null;
  // A selected title field shows as a field too, even beside the card title.
  const fields = layout.hideEmpty ? shown.filter((f) => !isEmptyValue(fieldValue(item, f))) : shown;
  const hasText = options.showTitle || fields.length > 0;
  const hasCover = typeof cover === "string" && !!cover;
  return (
    <ClickableTile
      href={`#/collections/${collection.id}/items/${item.id}`}
      {...itemLinkProps(item, actions)}
      className={
        !hasText ? "item-card item-card--image-only" : hasCover && listed ? "item-card item-card--cover-left" : "item-card"
      }
      aria-label={hasText ? undefined : itemLabel(collection, item)}
    >
      {typeof cover === "string" &&
        cover &&
        (kind === "markdown" ? (
          // Same area and shape as an image cover; what doesn't fit is cut off.
          <div className="item-card__cover item-card__cover--markdown">
            <MarkdownView source={cover} highlight={search} variant="excerpt" />
          </div>
        ) : kind === "html" ? (
          <div className="item-card__cover item-card__cover--html">
            <HtmlFrame html={cover} fill />
          </div>
        ) : kind === "url" ? (
          <CardCover src={cover} onRatio={onRatio} />
        ) : (
          <CardCover fileId={cover} onRatio={onRatio} />
        ))}
      {hasText && (
        <div className="item-card__body">
      {options.showTitle && (
        <div className="item-card__title">
          <Highlight text={itemLabel(collection, item)} query={search} />
        </div>
      )}
      {fields.length > 0 && (
        <dl className="item-card__fields">
          {fields.map((f) => (
            <div key={f.id} className="item-card__field">
              {!layout.hiddenLabels.includes(f.id) && <dt className="cds--label">{f.name}</dt>}
              <dd>
                <FieldCell field={f} item={item} refs={refs} search={search} actions={actions} />
              </dd>
            </div>
          ))}
        </dl>
      )}
        </div>
      )}
    </ClickableTile>
  );
});

export function CardsView({ collection, result, fields, layout, options, refs, search, actions, collapsedGroups, onGroupCollapse }: BlockProps<CardOptions>) {
  const { components } = useStore();
  // The same for every card: the fields shown (but the cover), and what the cover shows.
  const shown = useMemo(() => fields.filter((f) => f.id !== options.coverFieldId), [fields, options.coverFieldId]);
  const kind = coverKind(collection.fields.find((f) => f.id === options.coverFieldId), components);
  const grouped = isGrouped(result);
  // "auto": every cover area takes the average ratio of the shown cards' images loaded so far
  // (not of covers seen before: filtered out, deleted, or of another cover field).
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const onRatio = useCallback((fileId: string, ratio: number) => {
    setRatios((r) => (r[fileId] === ratio ? r : { ...r, [fileId]: ratio }));
  }, []);
  const coverKeys = useMemo(() => {
    if (!options.coverFieldId || (kind !== "image" && kind !== "url")) return [];
    const keys = new Set<string>();
    for (const group of result.groups) {
      for (const item of group.items) {
        const v = item.values[options.coverFieldId];
        // Keyed as CardCover reports it: the file id, else the URL.
        if (typeof v === "string" && v) keys.add(kind === "url" ? (fileIdFromSrc(v) ?? v) : v);
      }
    }
    return [...keys];
  }, [result, options.coverFieldId, kind]);
  const known = coverKeys.map((k) => ratios[k]).filter((r): r is number => r !== undefined);
  const coverRatio =
    options.coverRatio === "auto"
      ? known.length > 0
        ? known.reduce((a, b) => a + b, 0) / known.length
        : FALLBACK_RATIO
      : ratioOf(options.coverRatio);

  const grid = useRef<HTMLDivElement>(null);
  const columns = useCardColumns(grid, options.cardWidth, result.total > 0);

  if (result.total === 0) return <p className="helper view-empty">No {collection.pluralName} match.</p>;
  const cards = (group: (typeof result.groups)[number]) => (
            <div
              className={options.coverRatio === "auto" ? "item-cards item-cards--auto-ratio" : "item-cards"}
              style={{ "--card-columns": columns, "--cover-ratio": coverRatio } as CSSProperties}
            >
              {group.items.map((item) => (
                <ItemCard
                  key={item.id}
                  collection={collection}
                  item={item}
                  options={options}
                  layout={layout}
                  shown={shown}
                  kind={kind}
                  refs={refs}
                  search={search}
                  actions={actions}
                  onRatio={onRatio}
                  listed={options.listNarrow && columns === 1}
                />
              ))}
            </div>
  );

  return (
    // Grouped: around the accordion, like grouped tables' .table-groups (the group heading styles
    // apply to what is inside it).
    <div ref={grid} className={grouped ? "view-groups" : undefined}>
      {grouped ? (
        // Same collapsible group lines as grouped tables (open by default, collapsing is stored with the view).
        <Accordion size="sm" align="start">
          {result.groups.map((group) => (
            <AccordionItem
              key={group.key}
              open={!collapsedGroups.includes(group.key)}
              onHeadingClick={({ isOpen }) => onGroupCollapse(group.key, !isOpen)}
              title={
                <span className="table-group__title">
                  {group.label}
                </span>
              }
            >
              {cards(group)}
            </AccordionItem>
          ))}
        </Accordion>
      ) : (
        result.groups.map((group) => <div key={group.key}>{cards(group)}</div>)
      )}
    </div>
  );
}

/**
 * Cards per row whose width comes closest to `targetRem`: the row's width (plus one gap) divided
 * by a card plus its gap, rounded to the nearest whole number. Follows the container's width.
 */
/** `present`: the grid is shown (its element exists); set up again when that changes. */
function useCardColumns(container: RefObject<HTMLDivElement | null>, targetRem: number, present: boolean): number {
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const gap = rem; // the grid's gap is spacing-05 (1rem)
      setColumns(Math.max(1, Math.round((el.clientWidth + gap) / (targetRem * rem + gap))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [container, targetRem, present]);
  return columns;
}

function CardOptionsEditor({ collection, options, onChange }: BlockOptionsProps<CardOptions>) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { components } = useStore();
  return (
    <div className="view-options">
      <div className="view-options__checks">
        <Checkbox
          id={`${uid}-cards-show-title`}
          labelText="Show title"
          checked={options.showTitle}
          onChange={(_, { checked }) => onChange({ ...options, showTitle: checked })}
        />
        <Checkbox
          id={`${uid}-cards-list-narrow`}
          labelText="Show as a list when narrow"
          checked={options.listNarrow}
          onChange={(_, { checked }) => onChange({ ...options, listNarrow: checked })}
        />
      </div>
      <Slider
        id={`${uid}-cards-width`}
        labelText="Card width"
        min={CARD_WIDTH.min}
        max={CARD_WIDTH.max}
        step={CARD_WIDTH.step}
        value={options.cardWidth}
        formatLabel={(v) => `${v}rem`}
        hideTextInput
        onChange={({ value }) => onChange({ ...options, cardWidth: value })}
      />
      <Select size="sm"
        id={`${uid}-cards-cover`}
        labelText="Cover"
        value={options.coverFieldId ?? ""}
        onChange={(e) => onChange({ ...options, coverFieldId: e.target.value || null })}
      >
        <SelectItem value="" text="None" />
        {coverFields(collection, components).map((f) => (
          <SelectItem key={f.id} value={f.id} text={f.name} />
        ))}
      </Select>
      <Select size="sm"
        id={`${uid}-cards-ratio`}
        labelText="Cover shape"
        disabled={!options.coverFieldId}
        value={options.coverRatio}
        onChange={(e) => onChange({ ...options, coverRatio: e.target.value as CoverRatio })}
      >
        {COVER_RATIOS.map((r) => (
          <SelectItem key={r.value} value={r.value} text={r.text} />
        ))}
      </Select>
    </div>
  );
}

export const cardsView = defineBlockType<CardOptions>({
  kind: "cards",
  label: "Cards",
  icon: GridIcon,
  defaultOptions: (collection) => ({ coverFieldId: imageFields(collection)[0]?.id ?? null, cardWidth: CARD_WIDTH.initial, coverRatio: "auto", showTitle: true, listNarrow: false }),
  uses: () => ({ query: true, fields: { labels: true, hideEmpty: true } }),
  normalizeOptions(raw, collection) {
    const o = (raw ?? {}) as Partial<CardOptions>;
    const ids = new Set(pickableFields(collection).map((f) => f.id));
    return {
      coverFieldId: (() => {
        // Stored views from before the rename call it imageFieldId.
        const id = o.coverFieldId ?? (o as { imageFieldId?: string | null }).imageFieldId;
        return id && ids.has(id) ? id : null;
      })(),
      cardWidth:
        typeof o.cardWidth === "number"
          ? Math.min(CARD_WIDTH.max, Math.max(CARD_WIDTH.min, Math.round(o.cardWidth)))
          : CARD_WIDTH.initial,
      coverRatio: COVER_RATIOS.some((r) => r.value === o.coverRatio) ? o.coverRatio! : "auto",
      showTitle: o.showTitle !== false,
      listNarrow: o.listNarrow === true,
    };
  },
  View: CardsView,
  OptionsEditor: CardOptionsEditor,
});
