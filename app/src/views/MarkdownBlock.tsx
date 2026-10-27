import { useMemo, useState } from "react";
import { ERROR_PREFIX, placeProblem, render } from "../domain/components";
import { Document } from "@carbon/icons-react";
import { blankField, type FieldDef } from "../domain/model";
import { captureEditStart, type EditStart } from "../ui/editStart";
import { ComponentValue } from "../ui/ComponentValue";
import { FieldEditor } from "../ui/FieldEditor";
import { defineBlockType, type BlockProps } from "./registry";

// A block with its own Markdown, kept in the view (or item view) it is in: its text is a local
// static component (domain/components.ts): GFM whose {{ }} sections may use $now but nothing about
// items (the same content wherever it is shown). "Save as shared component" in its Block settings
// promotes it to a shared component, which the block then shows as a component block. It behaves
// exactly like a Markdown field: the same read-only box (the text rendered), the same in-place
// editor (FieldEditor, on the text as written), so nothing moves when editing starts.

export interface MarkdownBlockOptions {
  text: string;
}

const SECTION_START = /\{\{/;

/** The field the block's text is edited as. */
const TEXT_FIELD: FieldDef = blankField("text", "Markdown", "markdown");

function MarkdownBlockView({ options, refs, onOptions }: BlockProps<MarkdownBlockOptions>) {
  /** Being edited, and where the text was clicked. */
  const [editing, setEditing] = useState<{ start?: EditStart } | null>(null);
  // Its sections run as a static component's (only $now); text without any is shown as written.
  const rendered = useMemo(() => {
    if (!SECTION_START.test(options.text)) return options.text;
    const problem = placeProblem({ code: options.text, ai: false }, "static");
    return problem ? ERROR_PREFIX + problem : render({ code: options.text, output: "markdown" });
  }, [options.text]);

  if (editing) {
    return (
      <div className="markdown-block markdown-block--editing">
        <FieldEditor
          field={TEXT_FIELD}
          value={options.text}
          refs={refs}
          start={editing.start}
          onSave={async (v) => {
            const text = typeof v === "string" ? v : "";
            if (text !== options.text) onOptions({ text });
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }
  const empty = !options.text.trim();
  const startEdit = (e: React.MouseEvent | React.KeyboardEvent) => {
    // Links keep working.
    if ((e.target as HTMLElement).closest("a")) return;
    setEditing({ start: "clientX" in e ? captureEditStart(e.currentTarget as HTMLElement, e) : undefined });
  };
  return (
    <div className="markdown-block">
      <div className="view-field">
        <div
          className={`view-field__value view-field__value--markdown view-field__editable${empty ? " view-field__value--empty" : ""}`}
          role="button"
          tabIndex={0}
          title="Click to edit"
          aria-label="Edit text"
          onClick={startEdit}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              startEdit(e);
            }
          }}
        >
          {!empty && <ComponentValue value={rendered} output="markdown" variant="page" />}
        </div>
      </div>
    </div>
  );
}

export const markdownBlock = defineBlockType<MarkdownBlockOptions>({
  kind: "markdown",
  label: "Markdown",
  icon: Document,
  defaultOptions: () => ({ text: "" }),
  normalizeOptions(raw) {
    const o = (raw ?? {}) as Partial<MarkdownBlockOptions>;
    return { text: typeof o.text === "string" ? o.text : "" };
  },
  // Plain text: no filter, sort or fields.
  uses: () => ({ query: false, groups: false, fields: null }),
  View: MarkdownBlockView,
});
