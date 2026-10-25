import { encodeAiInput } from "../../domain/ai";
import type { Statement } from "./protocol";

const UPSERT = `INSERT INTO field_values (item_id, field_id, value_text, value_number, value_json, updated_at)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1 AND deleted_at IS NULL)
          ON CONFLICT (item_id, field_id) DO UPDATE SET
            value_text = excluded.value_text,
            value_number = excluded.value_number,
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`;

const bind = (itemId: string, fieldId: string, output: "number" | "text", value: string | number | null, input: string, ts: string) => [
  itemId,
  fieldId,
  output === "number" ? null : (value as string | null),
  output === "number" ? (value as number | null) : null,
  input,
  ts,
];

/**
 * Stores what a model generated for an AI field: the value (text in value_text, a number in
 * value_number) and, in value_json, the fingerprint of the prompt it answers (domain/ai.ts). Written
 * only for an item that still exists, so a reply arriving after the item was deleted is dropped.
 */
export function generatedStatement(itemId: string, fieldId: string, output: "number" | "text", value: string | number | null, inputHash: string, ts: string): Statement {
  return { sql: UPSERT, bind: bind(itemId, fieldId, output, value, encodeAiInput(inputHash), ts) };
}

/**
 * Stores a value the user typed over an AI field's. Its fingerprint is empty until the next look at
 * the item fills it in (`acceptedStatement`): the repository can't render prompts.
 */
export function editedStatement(itemId: string, fieldId: string, output: "number" | "text", value: string | number | null, ts: string): Statement {
  return { sql: UPSERT, bind: bind(itemId, fieldId, output, value, encodeAiInput("", true), ts) };
}

/** Keeps a typed value as it is and records the prompt it stands for, so it is current (or, if that changes again, asked about). */
export function acceptedStatement(itemId: string, fieldId: string, inputHash: string, ts: string): Statement {
  return {
    sql: "UPDATE field_values SET value_json = ?3, updated_at = ?4 WHERE item_id = ?1 AND field_id = ?2",
    bind: [itemId, fieldId, encodeAiInput(inputHash, true), ts],
  };
}
