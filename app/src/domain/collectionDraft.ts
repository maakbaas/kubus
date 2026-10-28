// What makes a collection draft savable: the collection editor shows these problems at their
// inputs, the API answers with the first one. One rule for both.

import { fieldComponentProblem, type Component } from "./components";
import { isReferenceKind, type CollectionDraft } from "./model";

export interface DraftProblems {
  nameError?: string;
  pluralError?: string;
  /** By field id: the field's name. */
  fieldErrors: Record<string, string>;
  /** By field id: what the field points to (a collection) or its component (or prompt). */
  targetErrors: Record<string, string>;
  /** A collection always has a field (the last one can't be removed). */
  noFields: boolean;
  /** A remote collection's source: what it reads, or its key. */
  sourceError?: string;
  valid: boolean;
}

/** Why a field's settings beyond its name can't be saved (a reference without a collection, its component), or undefined. */
export function settingsProblem(f: CollectionDraft["fields"][number], components: Component[], remote = false): string | undefined {
  // A remote collection stores nothing: its fields show a column, or compute (a component field).
  if (remote && !f.column && f.kind !== "component") return "A remote collection's own fields are component fields";
  if (isReferenceKind(f.kind) && !f.targetCollectionId) return "Choose a collection";
  return fieldComponentProblem(f, components) ?? undefined;
}

export function draftProblems(draft: CollectionDraft, components: Component[]): DraftProblems {
  const fieldErrors: Record<string, string> = {};
  const targetErrors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const f of draft.fields) {
    const key = f.name.trim().toLowerCase();
    if (!key) fieldErrors[f.id] = "Name is required";
    else if (seen.has(key)) fieldErrors[f.id] = "Duplicate field name";
    seen.add(key);
    const problem = settingsProblem(f, components, !!draft.source);
    if (problem) targetErrors[f.id] = problem;
  }
  const nameError = draft.name.trim() ? undefined : "Name is required";
  const pluralError = draft.pluralName.trim() ? undefined : "Plural name is required";
  const noFields = draft.fields.length === 0;
  const source = draft.source;
  const sourceError = !source
    ? undefined
    : !source.columns.some((c) => c.name === source.key)
      ? "Choose the column that tells rows apart"
      : undefined;
  const valid = !nameError && !pluralError && !noFields && !sourceError && Object.keys(fieldErrors).length === 0 && Object.keys(targetErrors).length === 0;
  return { nameError, pluralError, fieldErrors, targetErrors, noFields, sourceError, valid };
}

/** The first problem of a draft, in a sentence (null: none). */
export function draftProblem(draft: CollectionDraft, components: Component[]): string | null {
  const p = draftProblems(draft, components);
  if (p.valid) return null;
  if (p.nameError) return p.nameError;
  if (p.pluralError) return p.pluralError;
  if (p.noFields) return "A collection needs at least one field";
  if (p.sourceError) return p.sourceError;
  for (const f of draft.fields) {
    const problem = p.fieldErrors[f.id] ?? p.targetErrors[f.id];
    if (problem) return `Field “${f.name}”: ${problem}`;
  }
  return null;
}
