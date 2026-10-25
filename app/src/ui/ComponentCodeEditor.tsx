import { createElement, Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { refractor } from "refractor";

// refractor's tree (hast): just the parts highlighting produces.
type HastNode = { type: "text"; value: string } | { type: "element"; tagName: string; properties?: { className?: string[] }; children: HastNode[] };

const toReact = (nodes: HastNode[]): ReactNode[] =>
  nodes.map((n, i) =>
    n.type === "text"
      ? n.value
      : createElement(n.tagName, { key: i, className: n.properties?.className?.join(" ") }, toReact(n.children)),
  );

const highlight = (text: string, language: string): ReactNode[] =>
  refractor.registered(language) ? toReact(refractor.highlight(text, language).children as HastNode[]) : [text];

/**
 * A component, highlighted: the text around the {{ }} sections as Markdown (or HTML, for HTML
 * output), the sections as JavaScript, the braces as punctuation.
 */
function highlightComponent(code: string, textLanguage: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of code.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const i = m.index ?? 0;
    parts.push(<Fragment key={`t${i}`}>{highlight(code.slice(at, i), textLanguage)}</Fragment>);
    parts.push(
      <span key={`s${i}`} className="code-editor__section">
        <span className="token punctuation">{"{{"}</span>
        {highlight(m[1], "javascript")}
        <span className="token punctuation">{"}}"}</span>
      </span>,
    );
    at = i + m[0].length;
  }
  parts.push(<Fragment key="end">{highlight(code.slice(at), textLanguage)}</Fragment>);
  return parts;
}

/**
 * The component editor (also HTML fields' editor): a plain text area (so typing, undo, selection and IME behave natively)
 * over an identically laid out, highlighted copy of its text, with line numbers beside it. Long
 * lines wrap to the width there is; each number sits at the first row of its line (measured in
 * the highlighted copy). It grows with its content. Looks like a Carbon text area (field background, bottom border, label,
 * helper text).
 */
export function ComponentCodeEditor({
  id,
  labelText,
  helperText,
  placeholder,
  value,
  html = false,
  language,
  onChange,
}: {
  id: string;
  labelText: ReactNode;
  helperText?: ReactNode;
  placeholder?: string;
  value: string;
  /** The text around the sections is HTML (else Markdown). */
  html?: boolean;
  /** The whole text is code in this language (no {{ }} sections around it). */
  language?: string;
  onChange(value: string): void;
}) {
  const lines = value.split("\n").length;
  const highlighted = useMemo(() => (language ? highlight(value, language) : highlightComponent(value, html ? "markup" : "markdown")), [value, html, language]);
  const pre = useRef<HTMLPreElement>(null);
  /** Set by Escape: the next Tab leaves the editor instead of indenting. */
  const tabLeaves = useRef(false);
  /** Where each line starts (px from the top), wrapped lines taking several rows. */
  const [tops, setTops] = useState<number[]>([]);
  useLayoutEffect(() => {
    const el = pre.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      const { paddingTop, lineHeight } = getComputedStyle(el);
      const first = parseFloat(paddingTop);
      const row = parseFloat(lineHeight);
      const next: number[] = [first];
      // A line ends at its newline: the next one starts below that character's row.
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && next.length < lines; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (let i = text.indexOf("\n"); i !== -1 && next.length < lines; i = text.indexOf("\n", i + 1)) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rects = range.getClientRects();
          const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
          // On the row grid: a character's box is a little shorter than its row.
          next.push(first + Math.round((rect.bottom - top - first) / row) * row);
        }
      }
      setTops((old) => (old.length === next.length && old.every((t, i) => Math.abs(t - next[i]) < 0.5) ? old : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, html, lines]);
  return (
    <div className="cds--form-item">
      <label htmlFor={id} className="cds--label">
        {labelText}
      </label>
      <div className="code-editor">
        <div className="code-editor__gutter" aria-hidden style={{ "--digits": String(lines).length } as CSSProperties}>
          {tops.map((t, i) => (
            <div key={i} style={{ insetBlockStart: t }}>
              {i + 1}
            </div>
          ))}
        </div>
        <div className="code-editor__scroll">
          <div className="code-editor__area">
            {/* The trailing newline keeps a last empty line as tall as the text area's. */}
            <pre ref={pre} className="code-editor__highlight" aria-hidden>
              {highlighted}
              {"\n"}
            </pre>
            <textarea
              id={id}
              className="code-editor__input"
              value={value}
              placeholder={placeholder}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              rows={1}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                // Tab indents (two spaces) instead of leaving the field; Shift+Tab still leaves, and
                // so does a Tab right after Escape (as in other code editors): no keyboard trap.
                const released = tabLeaves.current;
                tabLeaves.current = e.key === "Escape";
                if (e.key !== "Tab" || e.shiftKey || released) return;
                e.preventDefault();
                // Inserted as typing would be, so Ctrl+Z still undoes what came before. execCommand
                // is deprecated but the only way to keep a text area's undo history; without it,
                // replace the text.
                if (document.execCommand("insertText", false, "  ")) return;
                const el = e.currentTarget;
                const { selectionStart: start, selectionEnd: end } = el;
                onChange(value.slice(0, start) + "  " + value.slice(end));
                requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
              }}
            />
          </div>
        </div>
      </div>
      {helperText && <div className="cds--form__helper-text">{helperText}</div>}
    </div>
  );
}
