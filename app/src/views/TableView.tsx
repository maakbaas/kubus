import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  Accordion,
  AccordionItem,
  Checkbox,
  IconButton,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@carbon/react";
import { Add, ArrowRight, Close, Copy, DataTable as TableIcon, Edit, Save, TrashCan } from "@carbon/icons-react";
import { RowActions, rowButtonProps } from "../ui/RowActions";
import { useStore } from "../app/store";
import { objectLabel, pickableFields, type FieldDef, type FieldValue, type ObjectInstance, type ObjectType } from "../domain/model";
import { cellEditStart, type EditStart } from "../ui/editStart";
import { objectViewOf, FULL_LAYOUT, isRestricted, orderFields } from "../domain/fieldLayout";
import { isGrouped } from "../domain/query";
import { FieldEditor } from "../ui/FieldEditor";
import { FieldOrderEditor } from "../ui/FieldOrderEditor";
import { FieldInput, parseInputValue, toInputValue, type InputValue } from "../ui/FieldInput";
import { Highlight } from "../ui/Highlight";
import { formatValue, type RefOptions } from "../ui/useReferenceOptions";
import { errorMessage } from "../ui/useConfirm";
import { objectLinkProps, FieldCell, isInlineEditable, isMetaField } from "./cells";
import { openModeOf } from "../workspace/Workspace";
import { defineViewType, type ObjectActions, type ViewProps } from "./registry";

/** Table view options. */
export interface TableOptions {
  /** Field ids shown as columns, in this order; null = all, in the type's order. Without the
   *  title column, rows get an open button. */
  columns: string[] | null;
  /** The title column links to the object (else it is an ordinary, editable column and rows get an open button). */
  titleLink: boolean;
  /** In a narrow pane the rows restack as cards (else the table scrolls sideways). */
  stackNarrow: boolean;
}

/** The column that names an object and opens it (the type's first text field). */
const titleColumn = (type: ObjectType) => type.fields.find((f) => f.kind === "string");

/** Fields that get an input in the add row: everything editable inline, plus checkboxes. */
const addable = (f: FieldDef) => f.kind === "checkbox" || isInlineEditable(f.kind);

/**
 * The add row: one compact input per editable column; Enter (or the + button) creates the
 * object with everything filled in. Markdown, images and lists are left for the object page.
 */
interface AddRowProps {
  type: ObjectType;
  /** The table's visible columns. */
  columns: FieldDef[];
  refs: RefOptions;
  /** Values the new object starts with (in a group: the group's value), shown where a column is. */
  preset: Record<string, FieldValue>;
  /** The grouped-by field: not an input, the new object keeps its group's value. */
  groupBy?: string | null;
  create(values: Record<string, FieldValue>): Promise<void>;
  onClose(): void;
}

function AddRow({ type, columns, refs, preset, groupBy, create, onClose }: AddRowProps) {
  const { types } = useStore();
  const fields = columns.filter((f) => addable(f) && f.id !== groupBy);
  const blank = () => Object.fromEntries(fields.map((f) => [f.id, toInputValue(f.kind, preset[f.id] ?? null)])) as Record<string, InputValue>;
  const initial = JSON.stringify(blank());
  const [raw, setRaw] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const row = useRef<HTMLTableRowElement>(null);
  const title = titleColumn(type);

  // Opened by the "Add" button: start typing right away, in the title field (else the first).
  const focusStart = () =>
    (row.current?.querySelector<HTMLInputElement>("[data-title-cell] input") ?? row.current?.querySelector<HTMLInputElement>("input"))?.focus();
  useEffect(focusStart, []);

  /** Adds the object; false when nothing was added (invalid or empty input, or a failed save). */
  async function submit(): Promise<boolean> {
    // Preset values count too (also for fields without a column), but only typing makes an object.
    const values: Record<string, FieldValue> = { ...preset };
    const found: Record<string, string> = {};
    for (const f of fields) {
      const parsed = parseInputValue(f.kind, raw[f.id]);
      if ("error" in parsed) found[f.id] = parsed.error;
      else if (parsed.value !== null && parsed.value !== false) values[f.id] = parsed.value;
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || JSON.stringify(raw) === initial) return false;
    setBusy(true);
    try {
      await create(values);
      setRaw(blank());
      focusStart();
      return true;
    } catch (e) {
      setErrors({ [fields[0].id]: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Clicking outside the row (but not in its floating parts: calendar, dropdown menus) leaves
  // it, like a cell editor: what was entered is added, an untouched row just closes.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const touched = JSON.stringify(raw) !== initial;
  const touchedRef = useRef(touched);
  touchedRef.current = touched;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (row.current?.contains(target)) return;
      if (target.closest(".flatpickr-calendar, .cds--popover, .cds--modal, [role=listbox]")) return;
      // An invalid object stays open, showing its error.
      if (touchedRef.current) submitRef.current().then((added) => added && closeRef.current());
      else closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const inDropdown = (e.target as HTMLElement).getAttribute("role") === "combobox";
    if (e.key === "Escape" && !inDropdown && !document.querySelector(".flatpickr-calendar.open")) onClose();
    // In a dropdown Enter picks the highlighted object; elsewhere it adds the row.
    if (e.key !== "Enter" || inDropdown) return;
    e.preventDefault();
    submit();
  };

  return (
    <TableRow ref={row} className="table-add-row" onKeyDown={onKeyDown}>
      {columns.map((f) => (
        <TableCell key={f.id} data-title-cell={f.id === title?.id || undefined} data-label={f.name}>
          {/* The grouped-by field shows the group's value (it decides where the object lands). */}
          {f.id === groupBy && <div>{formatValue(f, preset[f.id] ?? null, refs)}</div>}
          {/* Inputs are laid over the cell, so they never change the column widths; a checkbox
              is small enough to stay in the flow. */}
          {addable(f) && f.id !== groupBy && (
            <div className={f.kind === "checkbox" ? undefined : "add-cell"}>
              <FieldInput
                field={f}
                value={raw[f.id]}
                error={errors[f.id]}
                compact
                idPrefix="add"
                options={f.targetTypeId ? refs[f.targetTypeId] : undefined}
                target={types.find((t) => t.id === f.targetTypeId)}
                onChange={(v) => {
                  setRaw((r) => ({ ...r, [f.id]: v }));
                  setErrors(({ [f.id]: _stale, ...rest }) => rest);
                }}
              />
            </div>
          )}
        </TableCell>
      ))}
      <TableCell className="row-actions">
        <span className="add-cell add-cell--actions">
          <IconButton autoAlign label="Save" kind="ghost" size="sm" align="top-end" disabled={busy} onClick={submit}>
            <Save />
          </IconButton>
          <IconButton autoAlign label="Close" kind="ghost" size="sm" align="top-end" onClick={onClose}>
            <Close />
          </IconButton>
        </span>
      </TableCell>
    </TableRow>
  );
}

interface CellProps {
  type: ObjectType;
  /** The title column: its cells link to the object. */
  isTitle: boolean;
  field: FieldDef;
  object: ObjectInstance;
  refs: RefOptions;
  search: string;
  actions: ObjectActions;
  /** Where the click that started editing was (the caret goes there), if it was a click. */
  editing: { start?: EditStart } | null;
  onEdit(start?: EditStart): void;
  onDone(): void;
}

/** A table cell: the title opens the object, inline-editable values edit in place. */
function Cell({ type, isTitle, field, object, refs, search, actions, editing, onEdit, onDone }: CellProps) {
  if (isTitle) {
    return (
      <Link href={`#/types/${type.id}/objects/${object.id}`} {...objectLinkProps(object, actions)}>
        <Highlight text={objectLabel(type, object)} query={search} />
      </Link>
    );
  }
  if (!isInlineEditable(field.kind) || isMetaField(field)) {
    // Wrapped so the column-width rules (one line where possible) apply to plain text too.
    return (
      <div>
        <FieldCell field={field} object={object} refs={refs} search={search} actions={actions} />
      </div>
    );
  }
  if (editing) {
    const editor = (
      <FieldEditor
        field={field}
        // The typed source when the shown value was rendered from {{ }} sections.
        value={object.sources?.[field.id] ?? object.values[field.id] ?? null}
        refs={refs}
        compact
        start={editing.start}
        idPrefix={`cell-${object.id}`}
        onSave={async (value) => {
          await actions.setValue(object, field, value);
          onDone();
        }}
        onCancel={onDone}
      />
    );
    // Wrapped text edits in place of the text, in the cell's own flow: its lines stay exactly
    // where they were (an overlay would be drawn at a rounded position, a pixel off).
    if (editing.start?.wrapped) return <div className="cell-inline-editor">{editor}</div>;
    // Otherwise the editor overlays the cell; the value stays rendered (invisibly) underneath
    // so the column keeps the width its content gave it.
    return (
      <div className="cell-edit-box">
        <div className="cell-editable cell-sizer" aria-hidden>
          <FieldCell field={field} object={object} refs={refs} search={search} actions={actions} />
        </div>
        <div className="cell-overlay">{editor}</div>
      </div>
    );
  }
  return (
    <div
      className="cell-editable"
      role="button"
      tabIndex={0}
      aria-label={`Edit ${field.name}`}
      onClick={(e) => onEdit(cellEditStart(e.currentTarget, e))}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      <FieldCell field={field} object={object} refs={refs} search={search} actions={actions} />
    </div>
  );
}

/** A table narrower than this restacks as cards (the `data-stacked` rules in styles.css). */
const STACK_BELOW_REM = 30;

/** Each table box's refill, so grouped tables can make their siblings follow a stacking change. */
const fills = new WeakMap<Element, (fromSibling?: boolean) => void>();

/**
 * An objects table. Columns are as wide as their content (see styles.css), so the table can end
 * before the pane does; then its last (actions) column is widened to fill the rest of the row.
 */
export function FillTable({ children, stack: stackable = true }: { children: ReactNode; /** Restack as cards when narrow (else scroll sideways). */ stack?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // Set up once (per stacking choice): the observer refills whenever the box or the table changes size.
  useLayoutEffect(() => {
    const el = box.current;
    const table = el?.querySelector("table");
    if (!el || !table) return;
    const fill = (fromSibling = false) => {
      const last = table.rows[0]?.lastElementChild as HTMLElement | null;
      if (!last) return;
      last.style.inlineSize = ""; // measure the table at its natural width
      el.removeAttribute("data-stacked");
      if (el.offsetParent === null) {
        // Hidden (a collapsed group): no say in the matter.
        delete el.dataset.wantsStack;
        return;
      }
      const width = el.clientWidth;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      // Stacked as cards (styles.css) when the pane is narrow, and also when the columns can't fit
      // it however they wrap (unbreakable content): a table never sticks out of its pane.
      if (stackable && (width <= STACK_BELOW_REM * rem || table.getBoundingClientRect().width > width + 0.5)) el.dataset.wantsStack = "";
      else delete el.dataset.wantsStack;
      // Grouped tables stack together: as soon as one needs it, all do.
      const group = el.closest<HTMLElement>(".table-groups");
      const wraps = group ? [...group.querySelectorAll<HTMLElement>(".table-wrap")] : [el];
      const stack = wraps.some((w) => "wantsStack" in w.dataset);
      if (group && !fromSibling && group.dataset.stacked !== String(stack)) {
        group.dataset.stacked = String(stack);
        for (const w of wraps) if (w !== el) fills.get(w)?.(true);
      }
      if (stack) {
        el.setAttribute("data-stacked", "");
        return;
      }
      const extra = Math.floor(width - table.getBoundingClientRect().width);
      if (extra > 0) last.style.inlineSize = `${parseFloat(getComputedStyle(last).width) + extra}px`;
    };
    fills.set(el, fill);
    fill();
    const observer = new ResizeObserver(() => fill());
    observer.observe(el);
    observer.observe(table);
    return () => {
      fills.delete(el);
      observer.disconnect();
    };
  }, [stackable]);
  return (
    // A size container: in a narrow pane the table restacks as cards (see .table-wrap in styles.css),
    // unless the view keeps it a table, which then scrolls sideways.
    <div ref={box} className={stackable ? "table-wrap" : "table-wrap table-wrap--scroll"}>
      <TableContainer className="objects-table">{children}</TableContainer>
    </div>
  );
}

/**
 * Grouped tables share their column widths: each column at least as wide as that column is in
 * any group, so the columns line up from group to group. The tables keep their own (auto)
 * layout; only minimum widths are set. Measured twice: a column that still grows somewhere
 * (wrapping text taking the room it can get) sets the minimum for all in the second pass. When
 * the shared widths don't fit beside the row icons, all shrink in proportion (no scrolling).
 * Collapsed groups don't count until opened.
 */
/** `active`: the grouped tables are shown (their box exists); set up again when that changes. */
function useSharedColumns(box: RefObject<HTMLDivElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const sync = () => {
      const tables = [...el.querySelectorAll("table")].filter((t) => t.offsetParent !== null);
      watch(tables);
      // The data columns' header cells (the last column holds the icons, widened by FillTable).
      const heads = tables.map((t) => [...(t.tHead?.rows[0]?.cells ?? [])].slice(0, -1));
      for (const cells of heads) for (const c of cells) c.style.minInlineSize = "";
      if (tables.length < 2) return;
      // What the icons need: the widest row's icons plus the cell's padding (the same in every
      // row), not the width FillTable gave the column.
      const first = tables[0].tBodies[0]?.rows[0]?.lastElementChild;
      const cs = first ? getComputedStyle(first) : null;
      const padding = cs ? parseFloat(cs.paddingInlineStart) + parseFloat(cs.paddingInlineEnd) : 0;
      const icons =
        padding +
        Math.max(
          0,
          ...tables.flatMap((t) =>
            [...(t.tBodies[0]?.rows ?? [])].map((r) => [...(r.lastElementChild?.children ?? [])].reduce((sum, c) => sum + c.getBoundingClientRect().width, 0)),
          ),
        );
      const room = (tables[0].parentElement?.clientWidth ?? 0) - icons;
      const measure = () => {
        const widths: number[] = [];
        for (const cells of heads) cells.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.getBoundingClientRect().width)));
        return widths;
      };
      const apply = (widths: number[]) => {
        const total = widths.reduce((sum, w) => sum + w, 0);
        const scale = total > room && room > 0 ? room / total : 1;
        for (const cells of heads) cells.forEach((c, i) => (c.style.minInlineSize = `${Math.floor(widths[i] * scale)}px`));
      };
      // All in one go, so nothing is drawn (or observed) in between.
      apply(measure());
      apply(measure());
    };
    // Set up once: re-synced when the box or a table changes size, and when groups come and go
    // (rows, opened / closed groups), at most once a frame.
    const sizes = new ResizeObserver(() => schedule());
    const watched = new Set<Element>();
    const watch = (tables: Element[]) => {
      for (const t of tables) if (!watched.has(t)) (watched.add(t), sizes.observe(t));
    };
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), sync()));
    };
    sizes.observe(el);
    const changes = new MutationObserver(schedule);
    changes.observe(el, { childList: true, subtree: true });
    sync();
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      changes.disconnect();
    };
  }, [box, active]);
}

/** The cell being edited: which, and where the click that started it was. */
interface EditingCell {
  objectId: string;
  fieldId: string;
  start?: EditStart;
}

interface ObjectRowProps {
  type: ObjectType;
  object: ObjectInstance;
  shown: FieldDef[];
  titleId: string | undefined;
  titleShown: boolean;
  refs: RefOptions;
  search: string;
  actions: ObjectActions;
  /** The edited cell when it is in this row, else null. */
  editing: EditingCell | null;
  setEditing: Dispatch<SetStateAction<EditingCell | null>>;
}

/**
 * One object's row. Memoized: with stable props (an unchanged object, the same columns, refs and
 * actions) a row isn't rendered again when another row is edited, or something else on the page
 * changes.
 */
const ObjectRow = memo(function ObjectRow({ type, object, shown, titleId, titleShown, refs, search, actions, editing, setEditing }: ObjectRowProps) {
  // Its page's layout holds something back (read-only, fields left out): like the page's
  // own edit icon, an edit button opens it with every field, editable.
  const restricted = isRestricted(type, object, objectViewOf(type, object)?.layout ?? FULL_LAYOUT);
  const rowButtons = (inMenu: boolean) => {
    const props = rowButtonProps(inMenu);
    return (
      <>
        {/* Without the title column (its link opens the object), each row gets an open button. */}
        {!titleShown && (
          <IconButton {...props} label={`Open ${type.name}`} onClick={(e) => actions.open(object, openModeOf(e))}>
            <ArrowRight />
          </IconButton>
        )}
        {restricted && (
          <IconButton {...props} label="Edit all fields" onClick={(e) => actions.open(object, openModeOf(e), { edit: true })}>
            <Edit />
          </IconButton>
        )}
        {actions.duplicate && (
          <IconButton {...props} label="Duplicate" onClick={() => actions.duplicate?.(object)}>
            <Copy />
          </IconButton>
        )}
        <IconButton {...props} label="Delete" onClick={() => actions.remove(object)}>
          <TrashCan />
        </IconButton>
      </>
    );
  };
  return (
    <TableRow>
      {shown.map((f) => {
        const isEditing = editing?.fieldId === f.id;
        return (
          <TableCell key={f.id} className={`cell--${f.kind}${isEditing ? " cell--editing" : ""}`} data-label={f.name}>
            <Cell
              type={type}
              isTitle={f.id === titleId}
              field={f}
              object={object}
              refs={refs}
              search={search}
              actions={actions}
              editing={isEditing ? { start: editing.start } : null}
              onEdit={(start) => setEditing({ objectId: object.id, fieldId: f.id, start })}
              // Clicking another cell saves this one; don't close the editor that click opened.
              onDone={() => setEditing((cur) => (cur?.objectId === object.id && cur.fieldId === f.id ? null : cur))}
            />
          </TableCell>
        );
      })}
      <RowActions>{rowButtons}</RowActions>
    </TableRow>
  );
});

export function TableView(props: ViewProps<TableOptions>) {
  const { type, result, options, refs, search, actions } = props;
  const shown = useMemo(() => orderFields(pickableFields(type), options.columns), [type, options.columns]);
  // Without the title link the title is an ordinary column (and rows get an open button).
  const titleId = options.titleLink ? titleColumn(type)?.id : undefined;
  const titleShown = shown.some((f) => f.id === titleId);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  /** The group whose add row is open ("" when not grouped), or null. */
  const [adding, setAdding] = useState<string | null>(null);
  const groupsBox = useRef<HTMLDivElement>(null);
  const grouped = isGrouped(result);
  useSharedColumns(groupsBox, grouped && result.total > 0);
  const columns = shown.length + 1; // + actions

  const head = (
    <TableHead>
      <TableRow>
        {shown.map((f) => {
          const active = actions.sort?.fieldId === f.id;
          return (
            <TableHeader
              key={f.id}
              className={`cell--${f.kind}`}
              isSortable={!!actions.sortBy}
              isSortHeader={active}
              sortDirection={active ? (actions.sort!.direction === "asc" ? "ASC" : "DESC") : "NONE"}
              onClick={() => actions.sortBy?.(f.id)}
            >
              {f.name}
            </TableHeader>
          );
        })}
        <TableHeader aria-label="Actions" />
      </TableRow>
    </TableHead>
  );

  const rows = (objects: ObjectInstance[], groupKey: string) =>
    objects.map((object) => (
      <ObjectRow
        key={`${groupKey}-${object.id}`}
        type={type}
        object={object}
        shown={shown}
        titleId={titleId}
        titleShown={titleShown}
        refs={refs}
        search={search}
        actions={actions}
        // Only the row being edited gets the editing state, so the other rows keep their props.
        editing={editing?.objectId === object.id ? editing : null}
        setEditing={setEditing}
      />
    ));

  // The last row is empty but for a "+" in the title column (else the first); it turns into the
  // add row. Grouped, each group has one, and what it adds gets the group's value.
  const plusColumn = (shown.some((f) => f.id === titleColumn(type)?.id) ? titleColumn(type)?.id : undefined) ?? shown[0]?.id;
  const addRows = (groupKey: string) =>
    actions.create &&
    (adding === groupKey ? (
      <AddRow
        type={type}
        columns={shown}
        refs={refs}
        preset={actions.groupPreset?.(groupKey) ?? {}}
        groupBy={grouped ? actions.groupBy : null}
        create={actions.create}
        onClose={() => setAdding(null)}
      />
    ) : (
      <TableRow className="table-add-row table-add-row--idle">
        {shown.map((f) => (
          <TableCell key={f.id} className={f.id === plusColumn ? "table-add-row__plus" : undefined} data-label={f.name}>
            {f.id === plusColumn && (
              <IconButton autoAlign label={`Add ${type.name}`} kind="ghost" size="sm" align="top-start" onClick={() => setAdding(groupKey)}>
                <Add />
              </IconButton>
            )}
          </TableCell>
        ))}
        <TableCell className="row-actions" />
      </TableRow>
    ));

  const empty = result.total === 0 && (
    <TableRow>
      <TableCell colSpan={columns} className="table-empty">
        No {type.pluralName} match.
      </TableCell>
    </TableRow>
  );

  if (!grouped || result.total === 0) {
    return (
      <FillTable stack={options.stackNarrow}>
        <Table size="sm">
          {head}
          <TableBody>
            {empty}
            {rows(result.groups[0]?.objects ?? [], "")}
            {addRows("")}
          </TableBody>
        </Table>
      </FillTable>
    );
  }

  // Grouped: one table per group in a collapsible section (open by default; collapsing is
  // not saved), each with its own add row.
  return (
    <div ref={groupsBox} className="table-groups">
      <Accordion size="sm" align="start">
        {result.groups.map((group) => (
          <AccordionItem
            key={group.key}
            open
            title={
              <span className="table-group__title">
                {group.label} <span className="view-group__count">{group.objects.length}</span>
              </span>
            }
          >
            <FillTable stack={options.stackNarrow}>
              <Table size="sm">
                {head}
                <TableBody>
                  {rows(group.objects, group.key)}
                  {addRows(group.key)}
                </TableBody>
              </Table>
            </FillTable>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

function TableOptionsEditor({ type, options, onChange }: { type: ObjectType; options: TableOptions; onChange(o: TableOptions): void }) {
  const uid = useId();
  return (
    <div className="view-options">
      <Checkbox
        id={`${uid}-table-title-link`}
        labelText="Title links to the object"
        checked={options.titleLink}
        onChange={(_, { checked }) => onChange({ ...options, titleLink: checked })}
      />
      <Checkbox
        id={`${uid}-table-stack`}
        labelText="Show rows as cards when narrow"
        checked={options.stackNarrow}
        onChange={(_, { checked }) => onChange({ ...options, stackNarrow: checked })}
      />
      <FieldOrderEditor
        id={`${uid}-table-columns`}
        label="Columns"
        fields={pickableFields(type)}
        type={type}
        value={options.columns}
        onChange={(columns) => onChange({ ...options, columns })}
      />
    </div>
  );
}

export const tableView = defineViewType<TableOptions>({
  kind: "table",
  label: "Table",
  icon: TableIcon,
  defaultOptions: () => ({ columns: null, titleLink: true, stackNarrow: true }),
  normalizeOptions(raw, type) {
    const o = (raw ?? {}) as Partial<TableOptions>;
    const ids = new Set(pickableFields(type).map((f) => f.id));
    return {
      columns: Array.isArray(o.columns) ? o.columns.filter((id) => ids.has(id)) : null,
      titleLink: o.titleLink !== false,
      stackNarrow: o.stackNarrow !== false,
    };
  },
  fieldsOf: (o) => o.columns,
  withFields: (o, columns) => ({ ...o, columns }),
  View: TableView,
  OptionsEditor: TableOptionsEditor,
});
