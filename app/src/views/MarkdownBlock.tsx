import { useState } from "react";
import { Document } from "@carbon/icons-react";
import type { FieldDef } from "../domain/model";
import { captureEditStart, type EditStart } from "../ui/editStart";
import { ComponentValue } from "../ui/ComponentValue";
import { FieldEditor } from "../ui/FieldEditor";
import { defineBlockType, type BlockProps } from "./registry";

// A block with its own Markdown, kept in the view (or item view) it is in, not in a reusable
// component: plain GFM, no {{ }} code (code lives in components; "Save as component" in its
// Block settings turns the text into a static component, reusable and open to code). It behaves
// exactly like a Markdown field: the same read-only box, the same in-place editor (FieldEditor),
// so nothing moves when editing starts.

export interface MarkdownBlockOptions {
  text: string;
}

/** The field the block's text is edited as. */
const TEXT_FIELD: FieldDef = {
  id: "text",
  collectionId: "",
  name: "Markdown",
  kind: "markdown",
  targetCollectionId: null,
  componentId: null,
  componentArgs: {},
  choiceFilter: [],
  toggleIcon: null, strikeThrough: false,
  aiPrompt: null,
  aiOutput: null,
  position: 0,
};

function MarkdownBlockView({ options, refs, onOptions }: BlockProps<MarkdownBlockOptions>) {
  /** Being edited, and where the text was clicked. */
  const [editing, setEditing] = useState<{ start?: EditStart } | null>(null);

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
          {!empty && <ComponentValue value={options.text} output="markdown" variant="page" />}
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
