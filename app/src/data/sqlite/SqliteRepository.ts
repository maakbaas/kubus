import { fieldKinds } from "../../domain/fieldKinds";
import { fileIdsIn } from "../../domain/files";
import {
  newId,
  now,
  type FieldDef,
  type FieldKind,
  type FieldValue,
  type ObjectInstance,
  type ObjectLabel,
  type ObjectType,
  type ObjectTypeDraft,
  valuesEqual,
  parseTemplateArgs,
} from "../../domain/model";
import { defaultQuery, type FilterRule } from "../../domain/query";
import type { Bookmark, BookmarkKind } from "../../domain/bookmarks";
import { parseObjectViews, withDefaultObjectView, type ObjectView } from "../../domain/fieldLayout";
import { hasSections, isTemplateOutput, type Template } from "../../domain/templates";
import type { SavedView } from "../../domain/views";
import type { DataChange, Repository } from "../repository";
import { SyncEngine } from "../sync/SyncEngine";
import { SqlClient } from "./client";
import type { Statement } from "./protocol";

interface TypeRow {
  id: string;
  name: string;
  plural_name: string;
  icon: string | null;
  description: string;
  object_views: string | null;
  created_at: string;
  updated_at: string;
}
interface FieldRow {
  id: string;
  type_id: string;
  name: string;
  kind: FieldKind;
  target_type_id: string | null;
  template_id: string | null;
  template_args: string | null;
  choice_filter: string | null;
  toggle_icon: string | null;
  position: number;
}
interface TemplateRow {
  id: string;
  name: string;
  params: string;
  code: string;
  output: string;
  frame_ratio: string | null;
  created_at: string;
  updated_at: string;
}
interface ViewRow {
  id: string;
  type_id: string;
  name: string;
  kind: string;
  config: string;
  position: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}
interface ObjectRow {
  id: string;
  type_id: string;
  object_view_id: string | null;
  created_at: string;
  updated_at: string;
}
interface ValueRow {
  object_id: string;
  field_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_datetime: string | null;
  value_bool: number | null;
  value_ref: string | null;
  value_file: string | null;
  value_json: string | null;
}

const toField = (r: FieldRow): FieldDef => ({
  id: r.id,
  typeId: r.type_id,
  name: r.name,
  kind: r.kind,
  targetTypeId: r.target_type_id,
  templateId: r.template_id,
  templateArgs: parseTemplateArgs(r.template_args),
  choiceFilter: parseJson<FilterRule[]>(r.choice_filter, []),
  toggleIcon: r.toggle_icon,
  position: r.position,
});

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Reads go straight to the worker; each mutating method collects its
 * statements and commits them as one transaction (one change set — the unit a
 * future sync outbox would record).
 */
export class SqliteRepository implements Repository {
  private constructor(private db: SqlClient) {
    this.sync = new SyncEngine(db, (...changes) => this.emit(...changes));
    this.subscribe(() => this.sync.localChange());
  }

  readonly sync: SyncEngine;

  private listeners = new Set<(change: DataChange) => void>();

  subscribe(listener: (change: DataChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Announces a committed change to every subscriber (other panes, reference labels, …). */
  private emit(...changes: DataChange[]) {
    for (const change of changes) for (const listener of this.listeners) listener(change);
  }

  private async typeOfObject(objectId: string): Promise<string | undefined> {
    return (await this.db.select<{ type_id: string }>("SELECT type_id FROM objects WHERE id = ?1", [objectId]))[0]?.type_id;
  }

  static async open(): Promise<SqliteRepository> {
    const db = await SqlClient.open();
    // Stable identity of this replica, needed once sync exists.
    await db.write([{ sql: "INSERT OR IGNORE INTO meta (key, value) VALUES ('replica_id', ?1)", bind: [newId()] }]);
    return new SqliteRepository(db);
  }

  get storage() {
    return { persistent: this.db.info.persistent };
  }

  async listTypes(): Promise<ObjectType[]> {
    const types = await this.db.select<TypeRow>(
      "SELECT * FROM object_types WHERE deleted_at IS NULL ORDER BY plural_name COLLATE NOCASE",
    );
    const fields = await this.db.select<FieldRow>(
      "SELECT * FROM fields WHERE deleted_at IS NULL ORDER BY position, created_at",
    );
    return types.map((t) => ({
      id: t.id,
      name: t.name,
      pluralName: t.plural_name,
      icon: t.icon,
      description: t.description,
      fields: fields.filter((f) => f.type_id === t.id).map(toField),
      objectViews: withDefaultObjectView(parseObjectViews(t.object_views)),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));
  }

  async saveType(draft: ObjectTypeDraft): Promise<void> {
    const ts = now();
    const writes: Statement[] = [];
    const existing = await this.db.select<{ id: string }>("SELECT id FROM object_types WHERE id = ?1", [draft.id]);
    if (existing.length === 0) {
      writes.push({
        sql: "INSERT INTO object_types (id, name, plural_name, icon, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        bind: [draft.id, draft.name, draft.pluralName, draft.icon, draft.description, ts],
      });
      // Every type starts with an ordinary (renamable, deletable) "All" view: a table of all
      // objects sorted by title; its options are filled in by the view type's normalizeOptions.
      writes.push({
        sql: `INSERT INTO views (id, type_id, name, kind, config, position, is_default, created_at, updated_at)
              VALUES (?1, ?2, 'All', 'table', ?3, 0, 0, ?4, ?4)`,
        bind: [newId(), draft.id, JSON.stringify({ query: defaultQuery(), options: null }), ts],
      });
    }

    const stored = await this.db.select<FieldRow>("SELECT * FROM fields WHERE type_id = ?1 AND deleted_at IS NULL", [
      draft.id,
    ]);
    const storedById = new Map(stored.map((f) => [f.id, f]));
    const keep = new Set(draft.fields.map((f) => f.id));

    for (const [position, f] of draft.fields.entries()) {
      const old = storedById.get(f.id);
      if (!old) {
        writes.push({
          sql: "INSERT INTO fields (id, type_id, name, kind, target_type_id, template_id, template_args, choice_filter, toggle_icon, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10, ?11, ?8, ?9, ?9)",
          bind: [f.id, draft.id, f.name, f.kind, f.targetTypeId, f.templateId, args(f), position, ts, choices(f), f.toggleIcon],
        });
      } else if (
        old.name !== f.name ||
        old.position !== position ||
        old.template_id !== f.templateId ||
        (old.template_args ?? null) !== args(f) ||
        (old.choice_filter ?? null) !== choices(f) ||
        old.toggle_icon !== f.toggleIcon
      ) {
        // Kind and target are immutable once created (values would need conversion); an
        // template field's template may change (its values are computed, not stored).
        writes.push({
          sql: "UPDATE fields SET name = ?1, position = ?2, template_id = ?3, template_args = ?4, updated_at = ?5, choice_filter = ?7, toggle_icon = ?8 WHERE id = ?6",
          bind: [
            f.name,
            position,
            old.kind === "template" ? f.templateId : old.template_id,
            old.kind === "template" ? args(f) : old.template_args,
            ts,
            f.id,
            choices(f),
            f.toggleIcon,
          ],
        });
      }
    }
    const removed = stored.filter((old) => !keep.has(old.id));
    for (const old of removed) {
      writes.push({ sql: "UPDATE fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, old.id] });
    }

    writes.push({
      sql: "UPDATE object_types SET name = ?1, plural_name = ?2, icon = ?3, description = ?4, updated_at = ?5 WHERE id = ?6",
      bind: [draft.name, draft.pluralName, draft.icon, draft.description, ts, draft.id],
    });
    for (const old of removed) {
      writes.push(...(await this.releaseFilesWhere("field_id = ?1", [old.id])));
    }
    await this.db.write(writes);
    this.emit({ scope: "types" });
  }

  async deleteType(typeId: string): Promise<void> {
    const referencing = await this.db.select<{ field: string; type: string }>(
      `SELECT f.name AS field, t.name AS type FROM fields f JOIN object_types t ON t.id = f.type_id
        WHERE f.target_type_id = ?1 AND f.type_id <> ?1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
      [typeId],
    );
    if (referencing.length > 0) {
      const where = referencing.map((r) => `“${r.field}” of ${r.type}`).join(", ");
      throw new Error(`Still referenced by ${where}. Remove those fields first.`);
    }
    const ts = now();
    await this.db.write([
      {
        sql: "UPDATE objects SET deleted_at = ?1, updated_at = ?1 WHERE type_id = ?2 AND deleted_at IS NULL",
        bind: [ts, typeId],
      },
      {
        sql: "UPDATE fields SET deleted_at = ?1, updated_at = ?1 WHERE type_id = ?2 AND deleted_at IS NULL",
        bind: [ts, typeId],
      },
      {
        sql: "UPDATE views SET deleted_at = ?1, updated_at = ?1 WHERE type_id = ?2 AND deleted_at IS NULL",
        bind: [ts, typeId],
      },
      { sql: "UPDATE object_types SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, typeId] },
      ...(await this.releaseFilesWhere("object_id IN (SELECT id FROM objects WHERE type_id = ?1)", [typeId])),
    ]);
    this.emit({ scope: "types" }, { scope: "objects", typeId }, { scope: "views", typeId });
  }

  async countObjectsByType(): Promise<Record<string, number>> {
    const rows = await this.db.select<{ type_id: string; n: number }>(
      "SELECT type_id, COUNT(*) AS n FROM objects WHERE deleted_at IS NULL GROUP BY type_id",
    );
    return Object.fromEntries(rows.map((r) => [r.type_id, r.n]));
  }

  async listObjects(type: ObjectType): Promise<ObjectInstance[]> {
    const objects = await this.db.select<ObjectRow>(
      "SELECT * FROM objects WHERE type_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC",
      [type.id],
    );
    const values = await this.db.select<ValueRow>(
      `SELECT fv.* FROM field_values fv
         JOIN objects o ON o.id = fv.object_id
        WHERE o.type_id = ?1 AND o.deleted_at IS NULL`,
      [type.id],
    );
    return this.assemble(type, objects, values);
  }

  async getObject(type: ObjectType, objectId: string): Promise<ObjectInstance | null> {
    const objects = await this.db.select<ObjectRow>(
      "SELECT * FROM objects WHERE id = ?1 AND type_id = ?2 AND deleted_at IS NULL",
      [objectId, type.id],
    );
    if (objects.length === 0) return null;
    const values = await this.db.select<ValueRow>("SELECT * FROM field_values WHERE object_id = ?1", [objectId]);
    return this.assemble(type, objects, values)[0];
  }

  async listLabels(type: ObjectType, objectIds?: string[]): Promise<ObjectLabel[]> {
    // Same rule as labelField: the first string field (in the type's field order) whose value
    // isn't blank.
    return this.db.select<ObjectLabel>(
      `SELECT o.id AS id,
              (SELECT fv.value_text FROM field_values fv JOIN fields f ON f.id = fv.field_id
                WHERE fv.object_id = o.id AND f.kind = 'string' AND f.deleted_at IS NULL
                  AND trim(fv.value_text, ' ' || char(9, 10, 13)) <> ''
                ORDER BY f.position, f.created_at LIMIT 1) AS label
         FROM objects o
        WHERE o.type_id = ?1 AND o.deleted_at IS NULL
          AND (?2 IS NULL OR o.id IN (SELECT value FROM json_each(?2)))`,
      [type.id, objectIds ? JSON.stringify(objectIds) : null],
    );
  }

  async createObject(type: ObjectType, values: Record<string, FieldValue>): Promise<string> {
    const id = newId();
    const ts = now();
    const writes: Statement[] = [
      { sql: "INSERT INTO objects (id, type_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)", bind: [id, type.id, ts] },
    ];
    // Only actual values: an empty field has no row, and template fields are computed, never stored.
    for (const field of type.fields) {
      const value = values[field.id];
      if (value != null && field.kind !== "template") writes.push(valueStatement(id, field, value, ts));
    }
    await this.db.write(writes);
    this.emit({ scope: "objects", typeId: type.id, objectId: id });
    return id;
  }

  async updateObject(type: ObjectType, objectId: string, values: Record<string, FieldValue>): Promise<void> {
    const current = await this.getObject(type, objectId);
    if (!current) throw new Error("Object not found");
    const ts = now();
    const writes: Statement[] = [];
    const replacedFiles: string[] = [];
    // Only touch changed fields: keeps per-field updated_at meaningful for merges.
    for (const field of type.fields) {
      if (!(field.id in values)) continue;
      const next = values[field.id] ?? null;
      const prev = current.values[field.id];
      if (valuesEqual(next, prev)) continue;
      writes.push(valueStatement(objectId, field, next, ts));
      if (field.kind === "image" && typeof prev === "string") replacedFiles.push(prev);
      if (field.kind === "markdown" && typeof prev === "string") {
        const kept = new Set(typeof next === "string" ? fileIdsIn(next) : []);
        replacedFiles.push(...fileIdsIn(prev).filter((id) => !kept.has(id)));
      }
    }
    if (writes.length === 0) return;
    writes.push({ sql: "UPDATE objects SET updated_at = ?1 WHERE id = ?2", bind: [ts, objectId] });
    writes.push(...replacedFiles.flatMap(releaseFile));
    await this.db.write(writes);
    this.emit({ scope: "objects", typeId: type.id, objectId });
  }

  async listViews(typeId: string): Promise<SavedView[]> {
    const rows = await this.db.select<ViewRow>(
      "SELECT * FROM views WHERE type_id = ?1 AND deleted_at IS NULL ORDER BY position, created_at",
      [typeId],
    );
    return rows.map((r) => {
      const config = JSON.parse(r.config) as Pick<SavedView, "query" | "options">;
      return {
        id: r.id,
        typeId: r.type_id,
        name: r.name,
        kind: r.kind,
        query: config.query,
        options: config.options,
        position: r.position,
        isDefault: r.is_default === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  async saveView(view: SavedView): Promise<void> {
    const ts = now();
    const config = JSON.stringify({ query: view.query, options: view.options });
    await this.db.write([
      {
        sql: `INSERT INTO views (id, type_id, name, kind, config, position, created_at, updated_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
              ON CONFLICT (id) DO UPDATE SET
                name = excluded.name, kind = excluded.kind, config = excluded.config,
                position = excluded.position, updated_at = excluded.updated_at`,
        bind: [view.id, view.typeId, view.name, view.kind, config, view.position, ts],
      },
    ]);
    this.emit({ scope: "views", typeId: view.typeId });
  }

  async setDefaultView(typeId: string, viewId: string | null): Promise<void> {
    await this.db.write([
      {
        sql: `UPDATE views SET is_default = (id IS ?2), updated_at = ?3
               WHERE type_id = ?1 AND deleted_at IS NULL AND is_default IS NOT (id IS ?2)`,
        bind: [typeId, viewId, now()],
      },
    ]);
    this.emit({ scope: "views", typeId });
  }

  async saveObjectViews(typeId: string, views: ObjectView[]): Promise<void> {
    await this.db.write([
      { sql: "UPDATE object_types SET object_views = ?1, updated_at = ?2 WHERE id = ?3", bind: [JSON.stringify(views), now(), typeId] },
    ]);
    this.emit({ scope: "types" });
  }

  async pinObjectView(objectId: string, viewId: string | null): Promise<void> {
    await this.db.write([
      { sql: "UPDATE objects SET object_view_id = ?1, updated_at = ?2 WHERE id = ?3", bind: [viewId, now(), objectId] },
    ]);
    const typeId = await this.typeOfObject(objectId);
    if (typeId) this.emit({ scope: "objects", typeId, objectId });
  }

  async listBookmarks(): Promise<Bookmark[]> {
    const rows = await this.db.select<{
      id: string;
      kind: BookmarkKind;
      type_id: string;
      target_id: string;
      label: string;
      position: number;
      created_at: string;
    }>(
      // Bookmarks of deleted views and objects aren't shown.
      `SELECT b.* FROM bookmarks b JOIN object_types t ON t.id = b.type_id AND t.deleted_at IS NULL
        WHERE b.deleted_at IS NULL
          AND (b.kind <> 'view' OR EXISTS (SELECT 1 FROM views v WHERE v.id = b.target_id AND v.deleted_at IS NULL))
          AND (b.kind <> 'object' OR EXISTS (SELECT 1 FROM objects o WHERE o.id = b.target_id AND o.deleted_at IS NULL))
        ORDER BY b.position, b.created_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      typeId: r.type_id,
      targetId: r.target_id,
      label: r.label,
      position: r.position,
      createdAt: r.created_at,
    }));
  }

  async addBookmark(kind: BookmarkKind, typeId: string, targetId: string, label: string): Promise<void> {
    const ts = now();
    await this.db.write([
      {
        sql: `INSERT INTO bookmarks (id, kind, type_id, target_id, label, position, created_at, updated_at)
              SELECT ?1, ?2, ?3, ?4, ?5, COALESCE(MAX(position), -1) + 1, ?6, ?6 FROM bookmarks WHERE deleted_at IS NULL`,
        bind: [newId(), kind, typeId, targetId, label, ts],
      },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async removeBookmark(targetId: string): Promise<void> {
    await this.db.write([
      { sql: "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE target_id = ?2 AND deleted_at IS NULL", bind: [now(), targetId] },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async relabelBookmark(targetId: string, label: string): Promise<void> {
    const changed = await this.db.select<{ id: string }>(
      "SELECT id FROM bookmarks WHERE target_id = ?1 AND deleted_at IS NULL AND label <> ?2",
      [targetId, label],
    );
    if (changed.length === 0) return;
    await this.db.write([
      { sql: "UPDATE bookmarks SET label = ?1, updated_at = ?2 WHERE target_id = ?3 AND deleted_at IS NULL", bind: [label, now(), targetId] },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async listTemplates(): Promise<Template[]> {
    const rows = await this.db.select<TemplateRow>("SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      params: parseJson<string[]>(r.params, []),
      code: r.code,
      output: isTemplateOutput(r.output) ? r.output : "markdown",
      frameRatio: r.frame_ratio,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async saveTemplate(x: Template): Promise<void> {
    await this.db.write([
      {
        sql: `INSERT INTO templates (id, name, params, code, output, frame_ratio, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?6, ?7, ?5, ?5)
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, params = excluded.params, code = excluded.code,
                output = excluded.output, frame_ratio = excluded.frame_ratio, updated_at = excluded.updated_at`,
        bind: [x.id, x.name, JSON.stringify(x.params), x.code, now(), x.output, x.frameRatio],
      },
    ]);
    this.emit({ scope: "templates" });
  }

  async deleteTemplate(templateId: string, options: { withFields?: boolean } = {}): Promise<void> {
    const users = await this.db.select<{ id: string; field: string; type: string }>(
      `SELECT f.id, f.name AS field, t.name AS type FROM fields f JOIN object_types t ON t.id = f.type_id
        WHERE f.template_id = ?1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
      [templateId],
    );
    if (users.length > 0 && !options.withFields) {
      throw new Error(`Still used by ${users.map((u) => `“${u.field}” of ${u.type}`).join(", ")}. Remove those fields first.`);
    }
    // A type always keeps a field: one whose only fields use this template can't lose them.
    const emptied = await this.db.select<{ type: string }>(
      `SELECT t.name AS type FROM object_types t
        WHERE t.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM fields f WHERE f.type_id = t.id AND f.deleted_at IS NULL AND f.template_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM fields f WHERE f.type_id = t.id AND f.deleted_at IS NULL AND f.template_id IS NOT ?1)`,
      [templateId],
    );
    if (emptied.length > 0) {
      throw new Error(`${emptied.map((e) => e.type).join(", ")} would be left without fields. Add another field there first.`);
    }
    const ts = now();
    await this.db.write([
      // Its fields go first (soft delete, like removing them in the type editor).
      ...users.map((u) => ({ sql: "UPDATE fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, u.id] })),
      { sql: "UPDATE templates SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, templateId] },
    ]);
    this.emit({ scope: "templates" }, ...(users.length > 0 ? [{ scope: "types" } as const] : []));
  }

  async deleteView(viewId: string): Promise<void> {
    const typeId = (await this.db.select<{ type_id: string }>("SELECT type_id FROM views WHERE id = ?1", [viewId]))[0]?.type_id;
    await this.db.write([{ sql: "UPDATE views SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [now(), viewId] }]);
    if (typeId) this.emit({ scope: "views", typeId });
  }

  async deleteObject(objectId: string): Promise<void> {
    const typeId = await this.typeOfObject(objectId);
    await this.db.write([
      { sql: "UPDATE objects SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [now(), objectId] },
      ...(await this.releaseFilesWhere("object_id = ?1", [objectId])),
    ]);
    if (typeId) this.emit({ scope: "objects", typeId, objectId });
  }

  async search(query: string, types: ObjectType[], limit = 50): Promise<ObjectInstance[]> {
    const q = query.trim();
    if (!q) return [];
    // Case-insensitive for ASCII only (SQLite's lower()); fine until there is an FTS index.
    // Markdown is matched without its backslash escapes: the editor stores a typed "[[" as
    // "\[\[" (and "*" as "\*", …), which a search for what was typed must still find.
    const hits = await this.db.select<{ id: string }>(
      `SELECT o.id FROM field_values fv
         JOIN objects o ON o.id = fv.object_id
         JOIN fields f ON f.id = fv.field_id
        WHERE o.deleted_at IS NULL AND f.deleted_at IS NULL
          AND f.kind IN ('string', 'markdown', 'string_list', 'checklist')
          AND instr(lower(CASE WHEN f.kind = 'markdown' THEN replace(fv.value_text, '\\', '') ELSE coalesce(fv.value_text, fv.value_json) END), lower(?1)) > 0
        GROUP BY o.id
        ORDER BY max(o.updated_at) DESC
        LIMIT ?2`,
      [q, limit],
    );
    if (hits.length === 0) return [];
    const ids = JSON.stringify(hits.map((h) => h.id));
    const objects = await this.db.select<ObjectRow>("SELECT * FROM objects WHERE id IN (SELECT value FROM json_each(?1))", [
      ids,
    ]);
    const values = await this.db.select<ValueRow>(
      "SELECT * FROM field_values WHERE object_id IN (SELECT value FROM json_each(?1))",
      [ids],
    );
    const byId = new Map<string, ObjectInstance>();
    for (const type of types) {
      const own = objects.filter((o) => o.type_id === type.id);
      if (own.length > 0) this.assemble(type, own, values).forEach((e) => byId.set(e.id, e));
    }
    return hits.map((h) => byId.get(h.id)).filter((e): e is ObjectInstance => !!e);
  }

  async releaseFiles(fileIds: string[]): Promise<void> {
    await this.db.write([...new Set(fileIds)].flatMap(releaseFile));
  }

  /** Release statements for every file referenced by the field_values matching `where`. */
  private async releaseFilesWhere(where: string, bind: string[]): Promise<Statement[]> {
    const rows = await this.db.select<{ value_file: string | null; markdown: string | null }>(
      `SELECT fv.value_file, CASE WHEN f.kind = 'markdown' THEN fv.value_text END AS markdown
         FROM field_values fv JOIN fields f ON f.id = fv.field_id
        WHERE (fv.value_file IS NOT NULL OR f.kind = 'markdown') AND ${where}`,
      bind,
    );
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.value_file) ids.add(r.value_file);
      if (r.markdown) fileIdsIn(r.markdown).forEach((id) => ids.add(id));
    }
    return [...ids].flatMap(releaseFile);
  }

  async putFile(data: Uint8Array, mime: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.db.write([
      {
        sql: "INSERT OR IGNORE INTO files (id, mime, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        bind: [id, mime, data.byteLength, data, now()],
      },
    ]);
    return id;
  }

  async getFile(fileId: string): Promise<{ data: Uint8Array; mime: string } | null> {
    const rows = await this.db.select<{ data: Uint8Array; mime: string }>("SELECT mime, data FROM files WHERE id = ?1", [
      fileId,
    ]);
    return rows[0] ?? null;
  }

  private assemble(type: ObjectType, objects: ObjectRow[], values: ValueRow[]): ObjectInstance[] {
    const fieldsById = new Map(type.fields.map((f) => [f.id, f]));
    const byObject = new Map<string, Record<string, FieldValue>>();
    for (const v of values) {
      const field = fieldsById.get(v.field_id);
      if (!field) continue; // value of a removed field
      const spec = fieldKinds[field.kind];
      const record = byObject.get(v.object_id) ?? {};
      // A number with {{ }} sections is stored as its text (see valueStatement).
      record[field.id] = field.kind === "number" && v.value_number == null && v.value_text != null ? v.value_text : spec.fromDb(v[spec.column]);
      byObject.set(v.object_id, record);
    }
    return objects.map((o) => ({
      id: o.id,
      typeId: o.type_id,
      values: byObject.get(o.id) ?? {},
      objectViewId: o.object_view_id,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    }));
  }
}

/**
 * Deletes a file once no live object uses it. Runs after the statements that drop
 * the reference, in the same transaction. Rows of soft-deleted objects/fields
 * still point at their files (and the FK forbids dangling ones), so those links
 * are cleared first — only when no live reference remains.
 */
function releaseFile(fileId: string): Statement[] {
  // A live use is an image field value, or a markdown value mentioning `files/<id>`.
  const liveUse = `EXISTS (
      SELECT 1 FROM field_values fv
        JOIN objects o ON o.id = fv.object_id
        JOIN fields f ON f.id = fv.field_id
       WHERE o.deleted_at IS NULL AND f.deleted_at IS NULL
         AND (fv.value_file = ?1 OR (f.kind = 'markdown' AND instr(fv.value_text, 'files/' || ?1) > 0)))`;
  return [
    {
      sql: `UPDATE field_values SET value_file = NULL WHERE value_file = ?1 AND NOT ${liveUse}`,
      bind: [fileId],
    },
    {
      sql: `DELETE FROM files WHERE id = ?1
              AND NOT EXISTS (SELECT 1 FROM field_values WHERE value_file = ?1)
              AND NOT ${liveUse}`,
      bind: [fileId],
    },
  ];
}

/** A reference field's choice filters as stored (JSON), or null for other fields / none. */
const choices = (f: ObjectTypeDraft["fields"][number]) =>
  (f.kind === "object" || f.kind === "object_list") && f.choiceFilter.length > 0 ? JSON.stringify(f.choiceFilter) : null;

/** A template field's variable mapping as stored (JSON), or null for other fields / none. */
const args = (f: ObjectTypeDraft["fields"][number]) =>
  f.kind === "template" && Object.keys(f.templateArgs).length > 0 ? JSON.stringify(f.templateArgs) : null;

function valueStatement(objectId: string, field: FieldDef, value: FieldValue, ts: string): Statement {
  const spec = fieldKinds[field.kind];
  const cols: Record<string, string | number | null> = {
    value_text: null,
    value_number: null,
    value_date: null,
    value_datetime: null,
    value_bool: null,
    value_ref: null,
    value_file: null,
    value_json: null,
  };
  cols[spec.column] = spec.toDb(value);
  // A number field's {{ }} sections (computed when shown) are text: kept in value_text.
  if (field.kind === "number" && hasSections(value)) cols.value_text = value;
  return {
    sql: `INSERT INTO field_values (object_id, field_id, value_text, value_number, value_date, value_datetime,
                                      value_bool, value_ref, value_file, value_json, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ON CONFLICT (object_id, field_id) DO UPDATE SET
            value_text = excluded.value_text,
            value_number = excluded.value_number,
            value_date = excluded.value_date,
            value_datetime = excluded.value_datetime,
            value_bool = excluded.value_bool,
            value_ref = excluded.value_ref,
            value_file = excluded.value_file,
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
    bind: [
      objectId,
      field.id,
      cols.value_text,
      cols.value_number,
      cols.value_date,
      cols.value_datetime,
      cols.value_bool,
      cols.value_ref,
      cols.value_file,
      cols.value_json,
      ts,
    ],
  };
}
