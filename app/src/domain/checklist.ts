// Checklist fields: a list of items, each checked or not. Stored like a list of strings (a JSON
// array in value_json), each item written as a GFM task line: "[x] Buy milk", "[ ] Call Anna".
// Readable in the database and in exports, searchable by its text, and the same notation the
// Markdown fields use for their task lists.

import { stringList, type FieldValue } from "./model";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

const ITEM = /^\[( |x|X)\] ?([\s\S]*)$/;

/** One stored item ("[x] text"); text without the marker reads as not done. */
export function parseItem(stored: string): ChecklistItem {
  const m = ITEM.exec(stored);
  return m ? { done: m[1] !== " ", text: m[2] } : { done: false, text: stored };
}

/** An item as stored. */
export const itemString = (item: ChecklistItem) => `[${item.done ? "x" : " "}] ${item.text}`;

/** A checklist value's items ([] when empty). */
export const checklistItems = (value: FieldValue | undefined): ChecklistItem[] =>
  stringList(value).map(parseItem);

/** "2/5": done of all; "" when empty. */
export function checklistProgress(value: FieldValue | undefined): string {
  const items = checklistItems(value);
  return items.length ? `${items.filter((i) => i.done).length}/${items.length}` : "";
}
