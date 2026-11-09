// The Markdown editor's format bar (docs/features.md "Markdown editor"): one set of buttons (markdownActions.ts), on a
// touch screen in a bar on top of the on-screen keyboard while the editor has focus (KeyboardBar), with a mouse
// floating over a selection, or over the caret stopped at the edge of styled text (SelectionBar). Every style button
// is selected while it is on for what is typed next (or all of the selection). Pressing a button never takes focus
// from the editor (the keyboard stays up).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ContainedList, ContainedListItem, IconButton, Popover, PopoverContent } from "@carbon/react";
import {
  Add,
  Code,
  FunctionMath,
  KeyboardOff,
  Link,
  ListBulleted,
  ListChecked,
  ListNumbered,
  Quotes,
  Redo,
  Table,
  TextBold,
  TextClearFormat,
  TextIndentLess,
  TextIndentMore,
  TextItalic,
  TextStrikethrough,
  TextFont,
  Undo,
} from "@carbon/icons-react";
import type { EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { redo, redoDepth, undo, undoDepth } from "@milkdown/kit/prose/history";
import { selectedRect } from "@milkdown/kit/prose/tables";
import {
  addColumnLeft,
  addColumnRight,
  addRowAbove,
  addRowBelow,
  alignColumn,
  anyStyle,
  blockKind,
  clearFormatting,
  columnAlignment,
  deleteColumns,
  deleteRows,
  indent,
  markActive,
  outdent,
  removeTable,
  setHeading,
  setList,
  toggleQuote,
  toggleStyle,
  type StyleMark,
} from "./markdownActions";
import { onViewportChange, panelRoom } from "./panelRoom";

type Command = (state: EditorState, dispatch?: EditorView["dispatch"]) => boolean;

/** Ctrl / ⌘ as the platform writes it, for the tooltips. */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = (keys: string) => (MAC ? keys.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : keys);

/** The inline styles' buttons. */
const STYLE_BUTTONS: { mark: StyleMark; label: string; keys?: string; icon: typeof TextBold }[] = [
  { mark: "strong", label: "Bold", keys: "Ctrl+B", icon: TextBold },
  { mark: "emphasis", label: "Italic", keys: "Ctrl+I", icon: TextItalic },
  { mark: "strike_through", label: "Strikethrough", keys: "Ctrl+Alt+X", icon: TextStrikethrough },
  { mark: "inlineCode", label: "Code", keys: "Ctrl+E", icon: Code },
  { mark: "math_inline", label: "Formula", icon: FunctionMath },
];

/** What the bar does that needs the editor around it: a link's dialog, the `/` menu. */
export interface BarHooks {
  /** Opens the link dialog for the selection, the link at the caret, or a new link. */
  onLink(): void;
  /** Starts the `/` menu at the caret (a `/` typed there). */
  onInsert(): void;
}

/** Runs a command on the editor and keeps the focus there. */
function run(view: EditorView, command: Command) {
  command(view.state, view.dispatch);
  if (!view.hasFocus()) view.focus();
}

/** Buttons and menus never take focus from the editor (on a touch screen the keyboard would go). */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/** A button of the bar: a Carbon ghost icon button, selected while on. */
function BarButton({ label, keys, on, disabled, onPress, children, align }: { label: string; keys?: string; on?: boolean; disabled?: boolean; onPress(): void; children: ReactNode; align: "top" | "bottom" }) {
  return (
    <IconButton autoAlign kind="ghost" size="sm" align={align} label={keys ? `${label} (${mod(keys)})` : label} isSelected={on} disabled={disabled} onMouseDown={keepFocus} onClick={onPress}>
      {children}
    </IconButton>
  );
}

/** A menu item: its words, run on the editor; `current`: the one now (marked). */
export interface MenuEntry {
  label: string;
  run(): void;
  current?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

/** The items of a menu: a Carbon contained list of words (no icon to guess), focus left in the editor. */
export function MenuList({ items, onDone }: { items: (MenuEntry | null)[]; onDone(): void }) {
  return (
    <div className="md-bar-menu" onMouseDown={keepFocus} onPointerDown={keepFocus}>
      <ContainedList label="" kind="on-page" size="sm">
        {items.map((item, i) =>
          item === null ? null : (
            <ContainedListItem
              key={item.label}
              className={[item.current && "md-bar-menu__item--current", item.danger && "md-bar-menu__item--danger", i > 0 && items[i - 1] === null && "md-bar-menu__item--group"].filter(Boolean).join(" ")}
              disabled={item.disabled}
              aria-current={item.current || undefined}
              onClick={() => {
                item.run();
                onDone();
              }}
            >
              {item.label}
            </ContainedListItem>
          ),
        )}
      </ContainedList>
    </div>
  );
}

/** A bar button opening a menu of words above or below it; selected while open. Escape or a press elsewhere closes it. */
function BarMenu({ label, icon, items, align, on }: { label: string; icon: ReactNode; items: (MenuEntry | null)[]; align: "top" | "bottom"; on?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number>();
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !box.current?.contains(e.target as Node) && setOpen(false);
    // Escape closes the menu only (not the editor around it).
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    const update = () => box.current && setRoom(panelRoom(box.current.getBoundingClientRect(), null));
    update();
    const stop = onViewportChange(update);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      stop();
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div ref={box} className="md-bar__menu" style={room !== undefined ? ({ "--popover-room": `${Math.max(room, 0)}px` } as React.CSSProperties) : undefined}>
      <Popover open={open} autoAlign align={align === "top" ? "top-start" : "bottom-start"} className="md-bar__popover">
        <IconButton autoAlign kind="ghost" size="sm" align={align} label={label} isSelected={open} className={on ? "md-bar__button--on" : undefined} onMouseDown={keepFocus} onClick={() => setOpen(!open)}>
          {icon}
        </IconButton>
        <PopoverContent>
          {open && <MenuList items={items} onDone={() => setOpen(false)} />}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The table menu's items for the selection's rows and columns (several selected: all of them). */
export function tableItems(view: EditorView, part: "row" | "col" | "all"): (MenuEntry | null)[] {
  const { state } = view;
  const rect = selectedRect(state);
  const rows = rect.bottom - rect.top;
  const cols = rect.right - rect.left;
  const align = columnAlignment(state);
  const item = (label: string, command: Command, extra: Partial<MenuEntry> = {}): MenuEntry => ({ label, run: () => run(view, command), ...extra });
  const rowItems = [item("Row above", addRowAbove), item("Row below", addRowBelow)];
  const colItems = [item("Column left", addColumnLeft), item("Column right", addColumnRight)];
  const aligns = [
    item("Align left", alignColumn("left"), { current: align === "left" }),
    item("Align center", alignColumn("center"), { current: align === "center" }),
    item("Align right", alignColumn("right"), { current: align === "right" }),
  ];
  const delRows = item(rows > 1 ? `Delete ${rows} rows` : "Delete row", deleteRows, { danger: true });
  const delCols = item(cols > 1 ? `Delete ${cols} columns` : "Delete column", deleteColumns, { danger: true });
  const delTable = item("Delete table", removeTable, { danger: true });
  if (part === "row") return [...rowItems, null, delRows, delTable];
  if (part === "col") return [...colItems, null, ...aligns, null, delCols, delTable];
  return [...rowItems, ...colItems, null, ...aligns, null, delRows, delCols, delTable];
}

/** The text style menu: Text and the headings, the current one marked. */
function textItems(view: EditorView): MenuEntry[] {
  const kind = blockKind(view.state);
  return [0, 1, 2, 3, 4, 5, 6].map((level) => ({
    label: level ? `Heading ${level}` : "Text",
    current: level ? kind.text === "heading" && kind.level === level : kind.text === "paragraph",
    run: () => run(view, setHeading(level)),
  }));
}

/**
 * The buttons: on a touch screen (`keyboard`) Undo and Redo, Insert and a table's menu first, Hide keyboard last; the
 * inline styles, Link and Clear formatting; then the block's kind (text style, quote, lists, indent).
 */
function FormatButtons({ view, keyboard, hooks }: { view: EditorView; keyboard: boolean; hooks: BarHooks }) {
  const { state } = view;
  const align = keyboard ? "top" : "bottom";
  const kind = blockKind(state);
  const inCode = !!state.selection.$from.parent.type.spec.code;
  const inList = kind.list !== null;
  const link = !!state.schema.marks.link && markActive(state, "link");
  return (
    <>
      {keyboard && (
        <span className="md-bar__group">
          <BarButton label="Undo" align={align} disabled={undoDepth(state) === 0} onPress={() => run(view, undo)}>
            <Undo />
          </BarButton>
          <BarButton label="Redo" align={align} disabled={redoDepth(state) === 0} onPress={() => run(view, redo)}>
            <Redo />
          </BarButton>
          <BarButton label="Insert" align={align} onPress={hooks.onInsert}>
            <Add />
          </BarButton>
          {kind.table && <BarMenu label="Table" align={align} icon={<Table />} items={tableItems(view, "all")} />}
        </span>
      )}
      <span className="md-bar__group">
        {STYLE_BUTTONS.map((b) => (
          <BarButton key={b.mark} label={b.label} keys={b.keys} align={align} on={markActive(state, b.mark)} disabled={inCode} onPress={() => run(view, toggleStyle(b.mark))}>
            <b.icon />
          </BarButton>
        ))}
        <BarButton label="Link" keys="Ctrl+K" align={align} on={link} disabled={inCode} onPress={hooks.onLink}>
          <Link />
        </BarButton>
        <BarButton label="Clear formatting" align={align} disabled={!anyStyle(state)} onPress={() => run(view, clearFormatting)}>
          <TextClearFormat />
        </BarButton>
      </span>
      {!kind.table && (
        <span className="md-bar__group">
          <BarMenu label="Text style" align={align} icon={<TextFont />} items={textItems(view)} on={kind.text === "heading"} />
          <BarButton label="Quote" keys="Ctrl+Shift+B" align={align} on={kind.quote} onPress={() => run(view, toggleQuote)}>
            <Quotes />
          </BarButton>
          <BarButton label="Bulleted list" keys="Ctrl+Alt+8" align={align} on={kind.list === "bullet"} onPress={() => run(view, setList("bullet"))}>
            <ListBulleted />
          </BarButton>
          <BarButton label="Numbered list" keys="Ctrl+Alt+7" align={align} on={kind.list === "ordered"} onPress={() => run(view, setList("ordered"))}>
            <ListNumbered />
          </BarButton>
          <BarButton label="Checklist" align={align} on={kind.list === "task"} onPress={() => run(view, setList("task"))}>
            <ListChecked />
          </BarButton>
          {inList && (
            <>
              <BarButton label="Outdent" keys="Shift+Tab" align={align} disabled={!outdent(state)} onPress={() => run(view, outdent)}>
                <TextIndentLess />
              </BarButton>
              <BarButton label="Indent" keys="Tab" align={align} disabled={!indent(state)} onPress={() => run(view, indent)}>
                <TextIndentMore />
              </BarButton>
            </>
          )}
        </span>
      )}
      {keyboard && (
        <span className="md-bar__group md-bar__group--end">
          <BarButton label="Hide keyboard" align={align} onPress={() => view.dom.blur()}>
            <KeyboardOff />
          </BarButton>
        </span>
      )}
    </>
  );
}

/**
 * On a touch screen, while the editor has focus: the bar on top of the on-screen keyboard (at the bottom of what can
 * be seen: `--keyboard-inset`), one row that scrolls sideways. Pane content makes room for it at its end
 * (`--keyboard-bar`, styles.css).
 */
export function KeyboardBar({ view, hooks }: { view: EditorView; hooks: BarHooks }) {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--keyboard-bar", "2.5rem");
    return () => {
      root.style.removeProperty("--keyboard-bar");
    };
  }, []);
  return createPortal(
    <div className="md-bar md-bar--keyboard" role="toolbar" aria-label="Format" onMouseDown={keepFocus} onPointerDown={keepFocus}>
      <div className="md-bar__row">
        <FormatButtons view={view} keyboard hooks={hooks} />
      </div>
    </div>,
    // In the app's theme (light / dark: its Theme is `.app-root`, main.tsx), at the window's level.
    document.querySelector(".app-root") ?? document.body,
  );
}

/** With a mouse: the bar floating above the selection (or the caret at a style's edge), in the editor's coordinates. */
export function SelectionBar({ view, box, at, hooks }: { view: EditorView; box: HTMLElement; at: number; hooks: BarHooks }) {
  const outer = box.getBoundingClientRect();
  let c: { left: number; top: number; bottom: number };
  try {
    c = view.coordsAtPos(at);
  } catch {
    return null;
  }
  return (
    <div className="md-bar-float" style={{ left: c.left - outer.left, top: c.top - outer.top, width: 1, height: c.bottom - c.top }} onMouseDown={keepFocus}>
      <Popover open autoAlign align="top-start" className="md-link-popover__popover">
        <span className="md-link-popover__anchor" />
        <PopoverContent>
          <div className="md-bar md-bar--float" role="toolbar" aria-label="Format">
            <FormatButtons view={view} keyboard={false} hooks={hooks} />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
