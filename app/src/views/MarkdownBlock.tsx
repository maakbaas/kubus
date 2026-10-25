import { useMemo, useState } from "react";
import { Document } from "@carbon/icons-react";
import { componentUses, ERROR_PREFIX, fieldLookup, itemsInput, render, type BlockInputs } from "../domain/components";
import type { FieldDef } from "../domain/model";
import { captureEditStart, type EditStart } from "../ui/editStart";
import { ComponentValue } from "../ui/ComponentValue";
import { FieldEditor } from "../ui/FieldEditor";
import { refLabelOf } from "../ui/useReferenceOptions";
import { defineBlockType, type BlockProps } from "./registry";

// A block with its own Markdown, kept in the view (or item view) it is in, not in a reusable
// component. The text can hold {{ }} sections like a component (without variables): $item on
// an item page, $items / $groups / $fields / $all from the block's items, so it is a static
// text, or a small summary of the block's items. It behaves exactly like a Markdown field: the
// same read-only box, the same in-place editor (FieldEditor), so nothing moves when editing starts.

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
  toggleIcon: null,
  aiPrompt: null,
  aiOutput: null,
  position: 0,
};

function MarkdownBlockView({ collection, result, fields, options, refs, all, page, onOptions }: BlockProps<MarkdownBlockOptions>) {
  /** Being edited, and where the text was clicked. */
  const [editing, setEditing] = useState<{ start?: EditStart } | null>(null);
  const value = useMemo(() => {
    const component = { params: [], code: options.text, output: "markdown" as const };
    const uses = componentUses(options.text);
    if (uses.scope === "item" && !page) return `${ERROR_PREFIX}This text needs an item: it uses $item`;
    const input = itemsInput(collection, refLabelOf(refs));
    const items = uses.items ? [...new Set(result.groups.flatMap((g) => g.items))] : [];
    const block: BlockInputs = {
      items: items.map(input),
      groups: uses.items ? result.groups.map((g) => ({ key: g.key, label: g.label, items: g.items.map(input) })) : [],
      fields: fields.map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
      all: /\$all\b/.test(options.text) ? all.map(input) : [],
    };
    return page
      ? render(component, [], page.item, fieldLookup(page.collection, page.item, page.refLabel), block)
      : render(component, [], undefined, undefined, block);
  }, [options.text, collection, result, fields, refs, all, page]);

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
          {!empty && <ComponentValue value={value} output="markdown" variant="page" />}
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
  // By what its text uses, like a component: static text has no filter, sort or fields.
  uses(options) {
    const uses = componentUses(options.text);
    return { query: uses.items, fields: uses.fields ? { labels: false, hideEmpty: false } : null };
  },
  View: MarkdownBlockView,
});
