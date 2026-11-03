import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTags } from "../app/tagIndex";
import { matchingTags, tagBeingTyped } from "../domain/tags";
import { TagPopover } from "./TagPicker";
import { onViewportChange, panelRoom } from "./panelRoom";

/** A plain text field being typed in: an input, a text area or a plain-text editable box (a wrapped cell's editor). */
type TextField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/** Where the tag being typed is: its field, its text and its start and end (the caret) in the field's text. */
interface Typing {
  field: TextField;
  query: string;
  from: number;
  to: number;
  /** The caret's box on screen. */
  caret: { left: number; top: number; bottom: number };
}

const isInput = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/**
 * Whether a field offers tags: a text input or text area, or a plain-text editable box, that isn't for something a tag
 * can't be (a number, a date, a picker's search, code: `.code-editor`) nor the Markdown editor (its own TagPicker), nor
 * marked `data-no-tags`.
 */
function offersTags(el: Element | null): el is TextField {
  if (!el || el.closest("[data-no-tags], .md-editor, .code-editor, .flatpickr-calendar")) return false;
  if (el instanceof HTMLInputElement) {
    return (el.type === "text" || el.type === "search") && !el.readOnly && !el.inputMode.match(/decimal|numeric/) && el.getAttribute("role") !== "combobox" && !el.closest(".cds--date-picker, .cds--list-box");
  }
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  return el instanceof HTMLElement && el.getAttribute("contenteditable") === "plaintext-only";
}

/** An input's caret on screen: its left edge plus the width of the text before it, in the input's font. */
function inputCaret(el: HTMLInputElement | HTMLTextAreaElement, at: number): Typing["caret"] {
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  if (el instanceof HTMLTextAreaElement) return { left: r.left + parseFloat(style.paddingLeft), top: r.top, bottom: r.bottom };
  const ctx = document.createElement("canvas").getContext("2d");
  let width = 0;
  if (ctx) {
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    width = ctx.measureText(el.value.slice(0, at)).width;
  }
  const left = Math.min(r.right, r.left + parseFloat(style.paddingLeft) + width - el.scrollLeft);
  return { left, top: r.top, bottom: r.bottom };
}

/** The tag being typed in a field at its caret, or null. */
function typingIn(field: TextField): Typing | null {
  if (isInput(field)) {
    const at = field.selectionStart;
    if (at === null || at !== field.selectionEnd) return null;
    const query = tagBeingTyped(field.value.slice(0, at));
    return query ? { field, query, from: at - query.length, to: at, caret: inputCaret(field, at) } : null;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed || !field.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(field);
  before.setEnd(range.startContainer, range.startOffset);
  const text = before.toString();
  const query = tagBeingTyped(text);
  if (!query) return null;
  const r = range.getBoundingClientRect();
  const box = r.height > 0 ? r : field.getBoundingClientRect();
  return { field, query, from: text.length - query.length, to: text.length, caret: { left: box.left, top: box.top, bottom: box.bottom } };
}

/** Selects `from`–`to` of a plain-text editable box's text. */
function selectInBox(box: HTMLElement, from: number, to: number) {
  const range = document.createRange();
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let started = false;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const end = seen + node.data.length;
    if (!started && from <= end) {
      range.setStart(node, from - seen);
      started = true;
    }
    if (started && to <= end) {
      range.setEnd(node, to - seen);
      break;
    }
    seen = end;
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Puts the chosen tag over what was typed of it, a space after it unless one follows, as typing would: through the
 * browser's own insert, so the field's input event (React's onChange) and undo go as usual.
 */
function insertTag(t: Typing, tag: string) {
  const { field, from, to } = t;
  const text = isInput(field) ? field.value : (field.textContent ?? "");
  const insert = /^\s/.test(text.slice(to, to + 1)) ? tag : `${tag} `;
  if (isInput(field)) field.setSelectionRange(from, to);
  else selectInBox(field, from, to);
  if (!document.execCommand("insertText", false, insert) && isInput(field)) {
    // Without execCommand: the value set as React's onChange expects it.
    const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, text.slice(0, from) + insert + text.slice(to));
    field.setSelectionRange(from + insert.length, from + insert.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * Tags offered in every plain text field (a cell's or an item page's text, a list's entries, the add row, the search
 * box…), as the Markdown editor's TagPicker offers them: typing `#` and a tag's start lists the tags in use at the caret;
 * ↑ ↓ move, Enter or Tab choose, Escape closes it (before the field's own keys: Enter doesn't save the field then).
 * One for the app: it watches what is typed in the page.
 */
export function TextTagComplete() {
  const { used } = useTags();
  const [typing, setTyping] = useState<Typing | null>(null);
  const [active, setActive] = useState(0);
  /** The field and place where Escape closed it: closed until another tag is begun. */
  const [dismissed, setDismissed] = useState<{ field: TextField; from: number } | null>(null);
  const [room, setRoom] = useState<number>();
  const tags = typing ? matchingTags(used, typing.query) : [];
  const shown = !!typing && !(dismissed?.field === typing.field && dismissed.from === typing.from) && tags.length > 0;

  useEffect(() => {
    const check = () => {
      const el = document.activeElement;
      const next = offersTags(el) ? typingIn(el) : null;
      setTyping((old) => (old?.field === next?.field && old?.query === next?.query && old?.from === next?.from ? old : next));
    };
    const onInput = (e: Event) => offersTags(e.target as Element) && check();
    const onSelection = () => check();
    const onBlur = () => setTimeout(check);
    document.addEventListener("input", onInput, true);
    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("focusout", onBlur, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("focusout", onBlur, true);
    };
  }, []);
  useEffect(() => setActive(0), [typing?.query]);
  useEffect(() => {
    if (!typing) setDismissed(null);
  }, [typing]);

  // While it shows it takes ↑ ↓ Enter Tab Escape, before the field and whatever it is in (a cell editor saving on Enter).
  const latest = useRef({ typing, tags, active });
  latest.current = { typing, tags, active };
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const { typing, tags, active } = latest.current;
      if (!typing || e.target !== typing.field || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
      if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "ArrowDown") setActive((active + 1) % tags.length);
      else if (e.key === "ArrowUp") setActive((active - 1 + tags.length) % tags.length);
      else if (e.key === "Escape") setDismissed({ field: typing.field, from: typing.from });
      else insertTag(typing, tags[Math.min(active, tags.length - 1)].tag);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);

  const caret = typing?.caret;
  useEffect(() => {
    if (!shown || !caret) return;
    const update = () => setRoom(panelRoom(new DOMRect(caret.left, caret.top, 1, caret.bottom - caret.top), null));
    update();
    return onViewportChange(update);
  }, [shown, caret?.left, caret?.top, caret?.bottom]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown || !typing) return null;
  return createPortal(
    <TagPopover
      fixed
      style={{ left: typing.caret.left, top: typing.caret.top, width: 1, height: typing.caret.bottom - typing.caret.top, ...(room !== undefined && { "--popover-room": `${Math.max(room, 0)}px` }) }}
      tags={tags}
      active={Math.min(active, tags.length - 1)}
      onPick={(tag) => insertTag(typing, tag)}
    />,
    // In the app's theme (light / dark: its Theme is `.app-root`, main.tsx).
    document.querySelector(".app-root") ?? document.body,
  );
}
