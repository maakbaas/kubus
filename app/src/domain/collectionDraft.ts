// What makes a collection draft savable: the collection editor shows these problems at their
// inputs, the API answers with the first one. One rule for both.

import { aiPromptProblem } from "./ai";
import { isReferenceKind, type CollectionDraft } from "./model";

export interface DraftProblems {
  nameError?: string;
  pluralError?: string;
  /** By field id: the field's name. */
  fieldErrors: Record<string, string>;
  /** By field id: what the field points to (a collection, a component) or its prompt. */
  targetErrors: Record<string, string>;
  /** A collection always has a field (the last one can't be removed). */
  noFields: boolean;
  valid: boolean;
}

export function draftProblems(draft: CollectionDraft): DraftProblems {
  const fieldErrors: Record<string, string> = {};
  const targetErrors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const f of draft.fields) {
    const key = f.name.trim().toLowerCase();
    if (!key) fieldErrors[f.id] = "Name is required";
    else if (seen.has(key)) fieldErrors[f.id] = "Duplicate field name";
    seen.add(key);
    if (isReferenceKind(f.kind) && !f.targetCollectionId) targetErrors[f.id] = "Choose a collection";
    if (f.kind === "component" && !f.componentId) targetErrors[f.id] = "Choose a component";
    if (f.kind === "ai") {
      const problem = aiPromptProblem(f.aiPrompt);
      if (problem) targetErrors[f.id] = problem;
    }
  }
  const nameError = draft.name.trim() ? undefined : "Name is required";
  const pluralError = draft.pluralName.trim() ? undefined : "Plural name is required";
  const noFields = draft.fields.length === 0;
  const valid = !nameError && !pluralError && !noFields && Object.keys(fieldErrors).length === 0 && Object.keys(targetErrors).length === 0;
  return { nameError, pluralError, fieldErrors, targetErrors, noFields, valid };
}

/** The first problem of a draft, in a sentence (null: none). */
export function draftProblem(draft: CollectionDraft): string | null {
  const p = draftProblems(draft);
  if (p.valid) return null;
  if (p.nameError) return p.nameError;
  if (p.pluralError) return p.pluralError;
  if (p.noFields) return "A collection needs at least one field";
  for (const f of draft.fields) {
    const problem = p.fieldErrors[f.id] ?? p.targetErrors[f.id];
    if (problem) return `Field “${f.name}”: ${problem}`;
  }
  return null;
}
