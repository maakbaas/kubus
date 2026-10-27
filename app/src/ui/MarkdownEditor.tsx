import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FormLabel, IconButton, InlineNotification, Modal, Popover, PopoverContent, TextInput } from "@carbon/react";
import { ColumnDelete, ColumnInsert, Edit, Launch, OverflowMenuHorizontal, OverflowMenuVertical, RowDelete, RowInsert, TrashCan, Unlink } from "@carbon/icons-react";
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { commonmark, linkSchema } from "@milkdown/kit/preset/commonmark";
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  gfm,
  selectColCommand,
  selectRowCommand,
} from "@milkdown/kit/preset/gfm";
import { deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable, selectedRect } from "@milkdown/kit/prose/tables";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { upload, uploadConfig, type Uploader } from "@milkdown/kit/plugin/upload";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $inputRule, $prose, callCommand } from "@milkdown/kit/utils";
import { prism } from "@milkdown/plugin-prism";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import { useStore } from "../app/store";
import type { Repository } from "../data";
import { fileIdFromSrc, fileSrc } from "../domain/files";
import { useLinks } from "../app/useLinks";
import { parseNameLink } from "../domain/links";
import { openModeOf, type OpenMode } from "../workspace/Workspace";
import type { EditStart } from "./editStart";
import { cachedFileUrl, fileUrl, IMAGE_TYPES, storeImageFile } from "./images";
import { errorMessage } from "./useConfirm";

// Strictly GitHub Flavored Markdown: the CommonMark preset plus the GFM preset
// (tables, task lists, strikethrough, autolinks, footnotes) and nothing else.
// The other plugins add behaviour, never syntax: history, clipboard,
// upload (paste/drop images), prism (code coloring), and the local plugins below.
// There is no toolbar: formatting is typed as markdown, images are pasted or dropped,
// links are edited from their hover popover.

/**
 * Makes GFM task items toggleable. The checkbox is drawn by CSS on the <li>
 * itself (see .md-editor__content in styles.css), so a click whose target is
 * the task <li> rather than its paragraph is a click on the checkbox.
 */
/**
 * Tab in a table's last cell adds a row and moves into its first cell (elsewhere in a table Tab
 * moves to the next cell, GFM's own keymap; that one does nothing in the last cell).
 */
const tabAddsRow = $prose(
  (ctx) =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
          if (!isInTable(view.state)) return false;
          const rect = selectedRect(view.state);
          if (rect.bottom !== rect.map.height || rect.right !== rect.map.width) return false;
          if (!callCommand(addRowAfterCommand.key)(ctx)) return false;
          goToNextCell(1)(view.state, view.dispatch);
          return true;
        },
      },
    }),
);

const taskToggle = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          mousedown(view, event) {
            const li = event.target as HTMLElement;
            if (!li.matches?.('li[data-item-type="task"]')) return false;
            const $pos = view.state.doc.resolve(view.posAtDOM(li, 0));
            for (let d = $pos.depth; d > 0; d--) {
              const node = $pos.node(d);
              if (node.type.name === "list_item" && node.attrs.checked != null) {
                event.preventDefault();
                view.dispatch(
                  view.state.tr.setNodeMarkup($pos.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }),
                );
                return true;
              }
            }
            return false;
          },
        },
      },
    }),
);

/**
 * Typing `[text](url)` turns into a link once `)` is typed (CommonMark has no
 * such input rule; pasted markdown is already parsed). Skips `![alt](src)`.
 */
const linkInputRule = $inputRule(
  (ctx) =>
    new InputRule(/(^|[^!])\[([^\]]+)\]\(([^)\s]+)\)$/, (state, match, start, end) => {
      const [, prefix, text, href] = match;
      const mark = linkSchema.type(ctx).create({ href });
      return state.tr
        .replaceWith(start + prefix.length, end, state.schema.text(text, [mark]))
        .removeStoredMark(mark.type);
    }),
);

/** Dispatched on the editor's content after every document change. */
const DOC_CHANGED = "kubus-doc-changed";

/** Dispatched on a link that was clicked; its detail is `{ href, mode }`. */
const OPEN_LINK = "kubus-open-link";

/** A plain click on a link opens it (a drag that selects text does not). */
const linkClick = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          click(view, event) {
            const a = (event.target as HTMLElement).closest?.("a");
            if (!a || !view.dom.contains(a) || !view.state.selection.empty) return false;
            event.preventDefault();
            // The component around the editor opens it (a page of the app needs its router).
            a.dispatchEvent(new CustomEvent(OPEN_LINK, { bubbles: true, detail: { href: a.getAttribute("href") ?? "", mode: openModeOf(event) } }));
            return true;
          },
        },
      },
    }),
);

/**
 * Document range covered by the link mark rendered as `a`; null when it isn't a link (any more),
 * e.g. the editor redrew it while typing beside it.
 */
function linkRange(view: EditorView, a: HTMLElement) {
  if (!a.isConnected || !view.dom.contains(a)) return null;
  let at: number;
  try {
    at = view.posAtDOM(a, 0);
  } catch {
    return null;
  }
  const $pos = view.state.doc.resolve(at);
  const parent = $pos.parent;
  if (parent.childCount === 0) return null;
  const offsets: number[] = [];
  let offset = 0;
  parent.forEach((child) => {
    offsets.push(offset);
    offset += child.nodeSize;
  });
  const i = Math.min($pos.index(), parent.childCount - 1);
  const mark = parent.child(i).marks.find((m) => m.type.name === "link");
  if (!mark) return null;
  let first = i;
  let last = i;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--;
  while (last < parent.childCount - 1 && mark.isInSet(parent.child(last + 1).marks)) last++;
  const start = $pos.start();
  return { from: start + offsets[first], to: start + offsets[last] + parent.child(last).nodeSize, mark };
}

/**
 * Reports the markdown after every document change, synchronously. (Milkdown's
 * listener plugin debounces, so text typed right before saving could be lost.)
 */
function changes(onChange: (markdown: string) => void) {
  return $prose(
    (ctx) =>
      new Plugin({
        view: () => ({
          update: (view, prevState) => {
            if (view.state.doc.eq(prevState.doc)) return;
            onChange(ctx.get(serializerCtx)(view.state.doc));
            view.dom.dispatchEvent(new CustomEvent(DOC_CHANGED, { bubbles: true }));
          },
        }),
      }),
  );
}

/** Languages offered for code blocks: refractor's common bundle (what prism colors), by canonical name. */
const CODE_LANGUAGES: [string, string][] = [
  ["", "Plain text"],
  ["bash", "Bash / Shell"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["graphql", "GraphQL"],
  ["markup", "HTML / XML"],
  ["ini", "INI"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["kotlin", "Kotlin"],
  ["lua", "Lua"],
  ["makefile", "Makefile"],
  ["markdown", "Markdown"],
  ["objectivec", "Objective-C"],
  ["perl", "Perl"],
  ["php", "PHP"],
  ["python", "Python"],
  ["r", "R"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["scss", "SCSS"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
];

/**
 * Code blocks get a language select (Carbon inline select markup) in their top-right
 * corner, shown while hovering or editing that block and laid over the code so it adds
 * no height: the read-only view renders the same block without it. Changing it sets the
 * fence language, which prism uses to color the code.
 */
const codeBlockLanguage = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          code_block: (node, view, getPos) => {
            const dom = document.createElement("div");
            dom.className = "md-code-block";
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            pre.append(code);

            const picker = document.createElement("div");
            picker.className = "md-code-block__language cds--select cds--select--inline";
            picker.contentEditable = "false";
            // Carbon's inline select markup: .cds--select--inline > --inline__wrapper > __wrapper > select.
            const inline = document.createElement("div");
            inline.className = "cds--select-input--inline__wrapper";
            const wrapper = document.createElement("div");
            wrapper.className = "cds--select-input__wrapper";
            const select = document.createElement("select");
            select.className = "cds--select-input";
            select.setAttribute("aria-label", "Code language");
            const languages = [...CODE_LANGUAGES];
            const current = String(node.attrs.language ?? "");
            if (current && !languages.some(([v]) => v === current)) languages.push([current, current]);
            for (const [value, label] of languages) select.add(new Option(label, value));
            select.value = current;
            select.addEventListener("change", () => {
              const pos = getPos();
              if (pos == null) return;
              view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: select.value }));
            });
            const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            chevron.setAttribute("class", "cds--select__arrow");
            chevron.setAttribute("viewBox", "0 0 10 6");
            chevron.setAttribute("width", "10");
            chevron.setAttribute("height", "6");
            chevron.innerHTML = '<path d="M5 6 0 1 .7.3 5 4.6 9.3.3 10 1z"/>';
            wrapper.append(select, chevron);
            inline.append(wrapper);
            picker.append(inline);
            dom.append(picker, pre);

            return {
              dom,
              contentDOM: code,
              update(next) {
                if (next.type !== node.type) return false;
                node = next;
                select.value = String(next.attrs.language ?? "");
                return true;
              },
              stopEvent: (event) => picker.contains(event.target as Node),
              ignoreMutation: (mutation) => picker.contains(mutation.target),
            };
          },
        },
      },
    }),
);

/** Renders `files/<sha256>` image sources from the shared file URL cache (no blink when reopening). */
function storedImages(repo: Repository) {
  return $prose(
    () =>
      new Plugin({
        props: {
          nodeViews: {
            image: (node) => {
              const img = document.createElement("img");
              img.alt = node.attrs.alt ?? "";
              if (node.attrs.title) img.title = node.attrs.title;
              const fileId = fileIdFromSrc(node.attrs.src ?? "");
              const cached = fileId ? cachedFileUrl(fileId) : undefined;
              if (!fileId) img.src = node.attrs.src;
              else if (cached) img.src = cached;
              else fileUrl(repo, fileId).then((url) => url && (img.src = url));
              return { dom: img };
            },
          },
        },
      }),
  );
}

interface Props {
  label: ReactNode;
  value: string;
  onChange(markdown: string): void;
  /** Called for every stored image, so the item editor can release unsaved ones. */
  onFileStored?(fileId: string): void;
  /** Where the read-only view was clicked / what was selected: start editing with the caret or selection there. */
  start?: EditStart;
}

export function MarkdownEditor(props: Props) {
  return (
    <MilkdownProvider>
      <EditorChrome {...props} />
    </MilkdownProvider>
  );
}

/** Label, editor, link popover and link dialog. Lives inside MilkdownProvider. */
function EditorChrome(props: Props) {
  const labelId = useId();
  const [loading, getEditor] = useInstance();
  const [error, setError] = useState<string>();
  /** The link being edited: its URL as typed, and where it is in the document (found when the dialog opens). */
  const [linkEdit, setLinkEdit] = useState<{ href: string; from: number; to: number } | null>(null);
  /** Hovered link and its box relative to the .md-editor element (the popover's positioning context). */
  const [hovered, setHovered] = useState<{
    a: HTMLElement;
    box: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const hideTimer = useRef<number>(undefined);
  const editorBox = useRef<HTMLDivElement>(null);
  const links = useLinks();
  const linksRef = useRef(links);
  linksRef.current = links;
  // A click on a link (see linkClick) opens it: a page of the app, or outside.
  useEffect(() => {
    const box = editorBox.current;
    if (!box) return;
    const onOpen = (e: Event) => {
      const { href, mode } = (e as CustomEvent<{ href: string; mode: OpenMode }>).detail;
      linksRef.current.open(href, mode).catch((err) => setError(errorMessage(err)));
    };
    box.addEventListener(OPEN_LINK, onOpen);
    return () => box.removeEventListener(OPEN_LINK, onOpen);
  }, []);
  // A link typed or pasted by name is stored by id as soon as it names a page (a rename then breaks
  // nothing). Each href is tried once: one that names nothing (yet) stays as written.
  const tried = useRef(new Set<string>());
  const getEditorRef = useRef(getEditor);
  getEditorRef.current = getEditor;
  useEffect(() => {
    const box = editorBox.current;
    if (!box) return;
    const rewrite = async () => {
      const view = getEditorRef.current()?.action((ctx: Ctx) => ctx.get(editorViewCtx));
      const type = view?.state.schema.marks.link;
      if (!view || !type) return;
      const names = new Set<string>();
      view.state.doc.descendants((node) => {
        for (const m of node.marks) {
          const href = m.type === type ? String(m.attrs.href ?? "") : "";
          if (href && !tried.current.has(href) && parseNameLink(href)) names.add(href);
        }
      });
      for (const href of names) {
        tried.current.add(href);
        const stored = await linksRef.current.toStored(href);
        if (stored === href || !view.dom.isConnected) continue;
        const tr = view.state.tr;
        view.state.doc.descendants((node, pos) => {
          const mark = node.marks.find((m) => m.type === type && m.attrs.href === href);
          if (mark) tr.removeMark(pos, pos + node.nodeSize, mark).addMark(pos, pos + node.nodeSize, type.create({ ...mark.attrs, href: stored }));
        });
        if (tr.docChanged || tr.steps.length) view.dispatch(tr);
      }
    };
    const onChanged = () => void rewrite().catch(() => {});
    box.addEventListener(DOC_CHANGED, onChanged);
    return () => box.removeEventListener(DOC_CHANGED, onChanged);
  }, []);
  /** The hovered link as shown: a page of the app by name (stored by id), else as it is. */
  const [hoveredShown, setHoveredShown] = useState("");
  const hoveredRaw = hovered?.a.getAttribute("href") ?? "";
  useEffect(() => {
    setHoveredShown(hoveredRaw);
    let current = true;
    links.toShown(hoveredRaw).then((s) => current && setHoveredShown(s));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredRaw]);
  /**
   * The table cell under the pointer: its table and row / column, for the row and column
   * handles (shown at its row's left edge and its column's top edge). Kept while the pointer
   * moves from the cell to a handle, gone when it leaves the editor.
   */
  const [cell, setCell] = useState<{ table: HTMLTableElement; row: number; col: number; kind: "row" | "col" } | null>(null);
  /** The handle whose menu is open (its row or column is selected meanwhile). */
  const [menu, setMenu] = useState<"row" | "col" | null>(null);
  /**
   * One handle at a time, by where the pointer is: in the first column (or the margin left of
   * the table) the row handle of its row; in the header row (or just above the table) the
   * column handle of its column; in the top-left cell whichever edge is nearer; elsewhere none.
   */
  const trackPointer = (x: number, y: number) => {
    if (menu) return;
    const margin = 20; // the handles' room outside the table, plus a little
    let found: typeof cell = null;
    for (const table of editorBox.current?.querySelectorAll<HTMLTableElement>(".md-editor__content table") ?? []) {
      const t = table.getBoundingClientRect();
      if (x < t.left - margin || x > t.right || y < t.top - margin || y > t.bottom) continue;
      const rows = [...table.rows];
      const head = rows[0]?.cells ?? [];
      const row = rows.findIndex((r) => {
        const b = r.getBoundingClientRect();
        return y >= b.top && y <= b.bottom;
      });
      const col = [...head].findIndex((c) => {
        const b = c.getBoundingClientRect();
        return x >= b.left && x <= b.right;
      });
      const first = head[0]?.getBoundingClientRect();
      const header = rows[0]?.getBoundingClientRect();
      const nearLeft = row >= 0 && !!first && x <= first.right;
      const nearTop = col >= 0 && !!header && y <= header.bottom;
      if (nearLeft && (!nearTop || x - t.left <= y - t.top)) found = { table, row, col: Math.max(col, 0), kind: "row" };
      else if (nearTop) found = { table, row: Math.max(row, 0), col, kind: "col" };
      break;
    }
    if (found?.table !== cell?.table || found?.row !== cell?.row || found?.col !== cell?.col || found?.kind !== cell?.kind) setCell(found);
  };
  // A click anywhere but the open menu (or its handle) closes it.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".md-table-handle")) setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);
  /** Opens a handle's menu, selecting its row or column in the editor (what the actions apply to). */
  const openMenu = (kind: "row" | "col") => {
    if (loading || !cell) return;
    const el = cell.table.rows[cell.row]?.cells[cell.col];
    if (!el) return;
    getEditor().action((ctx: Ctx) => {
      const view = ctx.get(editorViewCtx);
      const pos = view.posAtDOM(el, 0);
      callCommand(kind === "row" ? selectRowCommand.key : selectColCommand.key, { index: kind === "row" ? cell.row : cell.col, pos })(ctx);
      view.focus();
    });
    setMenu(kind);
  };
  /** Runs a table command on the selected row / column; the table changes, so the handles go. */
  const tableCommand = (run: (ctx: Ctx) => void) => {
    if (loading) return;
    getEditor().action((ctx: Ctx) => {
      run(ctx);
      ctx.get(editorViewCtx).focus();
    });
    setMenu(null);
    setCell(null);
  };
  /** Add row above: above the header too (the new row is the header, the old one moves down). */
  const addRowAbove = () =>
    tableCommand((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (selectedRect(view.state).top > 0) return void callCommand(addRowBeforeCommand.key)(ctx);
      rebuildTable(view, (rows, row) => [row.empty(rows[0], true), row.as(rows[0], false), ...rows.slice(1)], 0);
    });
  /** Delete row: the header too (the next row becomes the header); a table keeps one row below it. */
  const deleteRowHere = () =>
    tableCommand((ctx) => {
      const view = ctx.get(editorViewCtx);
      const index = selectedRect(view.state).top;
      rebuildTable(
        view,
        (rows, row) => {
          const rest = rows.filter((_, i) => i !== index);
          if (index === 0) rest[0] = row.as(rest[0], true);
          return rest.length === 1 ? [...rest, row.empty(rest[0], false)] : rest;
        },
        Math.max(0, index - 1),
      );
    });
  const proseCommand = (command: typeof deleteRow) =>
    tableCommand((ctx) => {
      const view = ctx.get(editorViewCtx);
      command(view.state, view.dispatch);
    });

  /** Runs a function against the editor view and returns focus to the editor. */
  const withView = (fn: (view: EditorView) => void) => {
    if (loading) return;
    getEditor().action((ctx: Ctx) => {
      const view = ctx.get(editorViewCtx);
      fn(view);
      view.focus();
    });
  };

  // Once the editor exists, put the caret (or the selection) where it was in the view:
  // view and editor lay text out identically, so the same screen points hit the same text.
  const startApplied = useRef(false);
  useEffect(() => {
    const start = props.start;
    if (loading || startApplied.current || !start) return;
    startApplied.current = true;
    withView((view) => {
      const posAt = (p: { x: number; y: number }) => view.posAtCoords({ left: p.x, top: p.y })?.pos;
      const { doc } = view.state;
      if (start.selection) {
        const from = posAt(start.selection.from);
        const to = posAt(start.selection.to);
        if (from != null && to != null) {
          view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(Math.min(from, to)), doc.resolve(Math.max(from, to)))));
          return;
        }
      }
      const pos = posAt(start.point) ?? doc.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(pos))));
    });
  });

  // Link hover popover: stays open while the pointer is on the link or the popover.
  const cancelHide = () => window.clearTimeout(hideTimer.current);
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setHovered(null), 250);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  function showLinkPopover(a: HTMLElement) {
    const container = editorBox.current;
    if (!container) return;
    const outer = container.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    setHovered({ a, box: { left: r.left - outer.left, top: r.top - outer.top, width: r.width, height: r.height } });
  }

  /** Where the link rendered as `a` is in the document, read now (null when it is gone). */
  function linkAt(a: HTMLElement): { from: number; to: number } | null {
    if (loading) return null;
    let found: { from: number; to: number } | null = null;
    getEditor().action((ctx: Ctx) => {
      const range = linkRange(ctx.get(editorViewCtx), a);
      if (range) found = { from: range.from, to: range.to };
    });
    return found;
  }

  function applyLink(href: string, from: number, to: number) {
    withView((view) => {
      const type = view.state.schema.marks.link;
      if (!type || to > view.state.doc.content.size) return;
      view.dispatch(view.state.tr.removeMark(from, to, type).addMark(from, to, type.create({ href })));
    });
  }

  function removeLink(target: HTMLElement) {
    withView((view) => {
      const range = linkRange(view, target);
      if (range) view.dispatch(view.state.tr.removeMark(range.from, range.to, range.mark.type));
    });
  }


  return (
    <div className="cds--form-item md-field">
      <FormLabel id={labelId}>{props.label}</FormLabel>
      <div
        ref={editorBox}
        className="md-editor"
        onMouseLeave={() => !menu && setCell(null)}
        onMouseMove={(e) => trackPointer(e.clientX, e.clientY)}
        onMouseOver={(e) => {
          const a = (e.target as HTMLElement).closest<HTMLElement>(".md-editor__content a");
          if (!a) return;
          cancelHide();
          if (hovered?.a !== a) showLinkPopover(a);
        }}
        onMouseOut={(e) => {
          if ((e.target as HTMLElement).closest(".md-editor__content a")) scheduleHide();
        }}
      >
        <EditorSurface {...props} labelId={labelId} onError={setError} />

        {cell?.table.isConnected && editorBox.current && (() => {
          // The handles sit just outside the table: the row's left of its row, the column's above
          // its column, each centred on it. Small (1rem by 1.5rem, see .md-table-handle).
          const outer = editorBox.current.getBoundingClientRect();
          const t = cell.table.getBoundingClientRect();
          const r = cell.table.rows[cell.row]?.getBoundingClientRect();
          const c = cell.table.rows[cell.row]?.cells[cell.col]?.getBoundingClientRect();
          if (!r || !c) return null;
          // The handle's short and long side (as in styles.css): 1rem by 1.5rem, on touch screens
          // 1.5rem by 2rem.
          const coarse = matchMedia("(pointer: coarse)").matches;
          const thin = coarse ? 24 : 16;
          const long = coarse ? 32 : 24;
          const cols = cell.table.rows[0]?.cells.length ?? 1;
          const handle = (kind: "row" | "col", left: number, top: number) => (
            <div className={`md-table-handle md-table-handle--${kind}`} style={{ left, top }} onMouseDown={(e) => e.preventDefault()}>
              <Popover open={menu === kind} align={kind === "row" ? "right-start" : "bottom-start"} autoAlign highContrast>
                <IconButton
                  autoAlign
                  kind="ghost"
                  size="xs"
                  align={kind === "row" ? "left" : "top"}
                  label={kind === "row" ? "Row" : "Column"}
                  isSelected={menu === kind}
                  onClick={() => (menu === kind ? setMenu(null) : openMenu(kind))}
                >
                  {kind === "row" ? <OverflowMenuVertical /> : <OverflowMenuHorizontal />}
                </IconButton>
                <PopoverContent>
                  <div className="md-link-popover__content md-table-menu">
                    {kind === "row" ? (
                      <>
                        <IconButton autoAlign label="Add row above" kind="ghost" size="sm" align="bottom" onClick={addRowAbove}>
                          <RowInsert />
                        </IconButton>
                        <IconButton autoAlign label="Add row below" kind="ghost" size="sm" align="bottom" onClick={() => tableCommand(callCommand(addRowAfterCommand.key))}>
                          <RowInsert />
                        </IconButton>
                        <IconButton autoAlign label="Delete row" kind="ghost" size="sm" align="bottom" onClick={deleteRowHere}>
                          <RowDelete />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <IconButton autoAlign label="Add column left" kind="ghost" size="sm" align="bottom" onClick={() => tableCommand(callCommand(addColBeforeCommand.key))}>
                          <ColumnInsert />
                        </IconButton>
                        <IconButton autoAlign label="Add column right" kind="ghost" size="sm" align="bottom" onClick={() => tableCommand(callCommand(addColAfterCommand.key))}>
                          <ColumnInsert />
                        </IconButton>
                        <IconButton autoAlign label="Delete column" kind="ghost" size="sm" align="bottom" disabled={cols <= 1} onClick={() => proseCommand(deleteColumn)}>
                          <ColumnDelete />
                        </IconButton>
                      </>
                    )}
                    <IconButton autoAlign label="Delete table" kind="ghost" size="sm" align="bottom" onClick={() => proseCommand(deleteTable)}>
                      <TrashCan />
                    </IconButton>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          );
          return (
            <>
              {/* Row: centred between the editor's left edge line (3px) and the table; column: its
                  dots just above the table's top border. */}
              {cell.kind === "row"
                ? handle("row", (3 + t.left - outer.left) / 2 - thin / 2, r.top - outer.top + (r.height - long) / 2)
                : handle("col", c.left - outer.left + (c.width - long) / 2, t.top - outer.top - thin + 2)}
            </>
          );
        })()}

        {hovered && (
          // Positioned box exactly over the link; the Carbon Popover anchors to it.
          <div className="md-link-popover" style={hovered.box} onMouseEnter={cancelHide} onMouseLeave={scheduleHide}>
            <Popover autoAlign open align="bottom-start" caret highContrast className="md-link-popover__popover">
              <span className="md-link-popover__anchor" />
              <PopoverContent>
                {/* Own wrapper: Carbon's .cds--popover-content rules would override layout set on it. */}
                <div className="md-link-popover__content">
                  <span className="md-link-popover__href" title={hoveredShown}>
                    {hoveredShown}
                  </span>
                  <IconButton autoAlign label="Open link" kind="ghost" size="sm" align="bottom" onClick={() => links.open(hoveredRaw).catch((err) => setError(errorMessage(err)))}>
                    <Launch />
                  </IconButton>
                  <IconButton autoAlign
                    label="Edit link"
                    kind="ghost"
                    size="sm"
                    align="bottom"
                    onClick={() => {
                      const range = linkAt(hovered.a);
                      if (range) setLinkEdit({ href: hoveredShown, ...range });
                      setHovered(null);
                    }}
                  >
                    <Edit />
                  </IconButton>
                  <IconButton autoAlign
                    label="Remove link"
                    kind="ghost"
                    size="sm"
                    align="bottom"
                    onClick={() => {
                      removeLink(hovered.a);
                      setHovered(null);
                    }}
                  >
                    <Unlink />
                  </IconButton>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>

      <Modal
        open={linkEdit !== null}
        size="xs"
        modalHeading="Edit link"
        primaryButtonText="Apply"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={!linkEdit?.href.trim()}
        onRequestClose={() => setLinkEdit(null)}
        onRequestSubmit={() => {
          // A page of the app typed by name is stored by id.
          if (linkEdit) {
            const { href, from, to } = linkEdit;
            links.toStored(href.trim()).then((stored) => applyLink(stored, from, to));
          }
          setLinkEdit(null);
        }}
      >
        <TextInput size="sm"
          id={`${labelId}-href`}
          labelText="URL"
          placeholder="https://"
          value={linkEdit?.href ?? ""}
          onChange={(e) => setLinkEdit((d) => (d ? { ...d, href: e.target.value } : d))}
        />
      </Modal>

      {error && <InlineNotification kind="error" lowContrast title={error} onClose={() => setError(undefined)} />}
    </div>
  );
}

/** Builds rows of a GFM table: one converted to a header or normal row, or an empty one shaped like another. */
interface RowKit {
  as(row: ProseNode, header: boolean): ProseNode;
  empty(like: ProseNode, header: boolean): ProseNode;
}

/**
 * Replaces the table the caret is in with the same table, its rows rebuilt by `build` (GFM: a
 * header row, then at least one normal row), and puts the caret in row `focusRow`.
 */
function rebuildTable(view: EditorView, build: (rows: ProseNode[], row: RowKit) => ProseNode[], focusRow: number) {
  const { state } = view;
  const rect = selectedRect(state);
  const n = state.schema.nodes;
  const cells = (row: ProseNode) => {
    const list: ProseNode[] = [];
    row.forEach((c) => list.push(c));
    return list;
  };
  const kit: RowKit = {
    as: (row, header) =>
      (header ? n.table_header_row : n.table_row).create(
        row.attrs,
        cells(row).map((c) => (header ? n.table_header : n.table_cell).create(c.attrs, c.content)),
      ),
    empty: (like, header) =>
      (header ? n.table_header_row : n.table_row).create(
        null,
        cells(like).map((c) => (header ? n.table_header : n.table_cell).createAndFill(c.attrs)!),
      ),
  };
  const rows: ProseNode[] = [];
  rect.table.forEach((r) => rows.push(r));
  const table = rect.table.type.create(rect.table.attrs, build(rows, kit));
  const pos = rect.tableStart - 1;
  const tr = state.tr.replaceWith(pos, pos + rect.table.nodeSize, table);
  let at = pos + 1;
  for (let i = 0; i < focusRow && i < table.childCount; i++) at += table.child(i).nodeSize;
  view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2))));
}

function EditorSurface({
  value,
  onChange,
  onFileStored,
  onError,
  labelId,
}: Props & { labelId: string; onError(message: string): void }) {
  const { repo } = useStore();
  const callbacks = useRef({ onChange, onFileStored, onError });
  useEffect(() => {
    callbacks.current = { onChange, onFileStored, onError };
  }, [onChange, onFileStored, onError]);

  // Pasted or dropped image files go to the file store, not into the markdown as base64.
  const uploader: Uploader = async (files, schema) => {
    const nodes: ProseNode[] = [];
    for (const file of Array.from(files)) {
      if (!IMAGE_TYPES.includes(file.type)) continue;
      try {
        const fileId = await storeImageFile(repo, file);
        callbacks.current.onFileStored?.(fileId);
        const node = schema.nodes.image.createAndFill({ src: fileSrc(fileId), alt: file.name });
        if (node) nodes.push(node);
      } catch (e) {
        callbacks.current.onError(errorMessage(e));
      }
    }
    return nodes;
  };

  // Uncontrolled: `value` seeds the editor once; changes flow out via onChange.
  useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, value);
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            attributes: {
              class: "md-editor__content",
              role: "textbox",
              "aria-multiline": "true",
              "aria-labelledby": labelId,
              spellcheck: "false",
            },
          }));
          ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader }));
        })
        .use(commonmark)
        .use(gfm)
        .use(taskToggle)
        .use(tabAddsRow)
        .use(linkInputRule)
        .use(linkClick)
        .use(storedImages(repo))
        .use(codeBlockLanguage)
        .use(changes((markdown) => callbacks.current.onChange(markdown)))
        .use(prism)
        .use(upload)
        .use(history)
        .use(clipboard),
    [],
  );

  return <Milkdown />;
}
