-- Kubus database schema.
--
-- PRE-ALPHA: there are no migrations. When this file changes, the worker detects
-- it (hash stored in PRAGMA user_version) and upgrades the local database in place
-- (new tables, columns, indexes, changed CHECKs); only an incompatible change
-- recreates it from scratch, deleting all local data.
--
-- Sync-readiness conventions (see CLAUDE.md):
--  * primary keys are client-generated UUIDs, never autoincrement
--  * every row carries updated_at (ISO 8601 UTC) for last-writer-wins merges
--  * deletes are soft (deleted_at tombstones) so they can be replicated
--  * field values are stored per (object, field) in typed columns, which maps
--    1:1 onto Postgres column types and allows field-level conflict resolution

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE object_types (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,   -- singular, e.g. "Author"
  plural_name TEXT NOT NULL,   -- e.g. "Authors"
  icon        TEXT,            -- name of a Carbon icon (@carbon/icons-react export), e.g. "Book"
  description TEXT NOT NULL DEFAULT '',
  object_views TEXT,           -- JSON [{ id, name, layout, isDefault }]: object page layouts (fieldLayout.ts)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

-- Saved views of a type's objects (see src/domain/views.ts and src/views/registry.ts).
CREATE TABLE views (
  id         TEXT PRIMARY KEY,
  type_id    TEXT NOT NULL REFERENCES object_types(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- view type, e.g. 'table', 'cards'
  config     TEXT NOT NULL,            -- JSON { query, options }; options validated by the view type
  position   INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,  -- the starred view, opened instead of "All" (at most one per type)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_views_type ON views(type_id);

-- Reusable Markdown with {{ JavaScript }} sections over named variables (src/domain/templates.ts).
-- A field of kind 'template' maps each variable to a field of its type and shows the result
-- (computed, never stored).
CREATE TABLE templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  params      TEXT NOT NULL DEFAULT '[]',  -- JSON array of variable names the code uses
  code        TEXT NOT NULL DEFAULT '',        -- Markdown with {{ JavaScript }} sections; $object is the current object
  output      TEXT NOT NULL DEFAULT 'markdown',  -- markdown | string | number | image | html (TemplateOutput)
  frame_ratio TEXT,                              -- html that fills its box: the box's shape on pages, e.g. '4/3' (null = 16/9)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE fields (
  id             TEXT PRIMARY KEY,
  type_id        TEXT NOT NULL REFERENCES object_types(id),
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'string', 'markdown', 'html', 'number', 'date', 'datetime', 'checkbox', 'image',
                   'object', 'string_list', 'checklist', 'object_list', 'template')),
  -- for reference kinds: the type whose objects can be referenced
  target_type_id TEXT REFERENCES object_types(id),
  -- for 'template' fields: the template whose result the field shows
  template_id  TEXT REFERENCES templates(id),
  -- for 'template' fields: JSON { variable: {"field": id} | {"value": text} } feeding the template's variables
  template_args TEXT,
  -- for reference kinds: JSON filter rules over the target's objects limiting the choices (null = any)
  choice_filter  TEXT,
  -- for 'checkbox' / 'checklist' fields: an icon shown instead of the box (a key of TOGGLE_ICONS in ui/ToggleInput.tsx; null = the box)
  toggle_icon    TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  CHECK ((kind IN ('object', 'object_list')) = (target_type_id IS NOT NULL))
);
CREATE INDEX idx_fields_type ON fields(type_id);
CREATE INDEX idx_fields_target ON fields(target_type_id);

CREATE TABLE objects (
  id         TEXT PRIMARY KEY,
  type_id    TEXT NOT NULL REFERENCES object_types(id),
  object_view_id TEXT,                  -- the object view (object_types.object_views) this object is pinned to
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_objects_type ON objects(type_id);

-- Binary content (images), content-addressed: id = SHA-256 of data, rows are immutable.
-- A file is deleted once no live object uses it (releaseFile in SqliteRepository.ts).
CREATE TABLE files (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- Exactly one value_* column is used, determined by the field's kind.
-- Lists are JSON arrays in value_json (SQLite json_each / Postgres jsonb) and merge as one value.
CREATE TABLE field_values (
  object_id      TEXT NOT NULL REFERENCES objects(id),
  field_id       TEXT NOT NULL REFERENCES fields(id),
  value_text     TEXT,     -- string, markdown (GFM)
  value_number   REAL,
  value_date     TEXT,     -- YYYY-MM-DD
  value_datetime TEXT,     -- ISO 8601 UTC
  value_bool     INTEGER,
  value_ref      TEXT REFERENCES objects(id),
  value_file     TEXT REFERENCES files(id),
  value_json     TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (object_id, field_id)
);
CREATE INDEX idx_field_values_field ON field_values(field_id);
CREATE INDEX idx_field_values_ref ON field_values(value_ref);

-- Bookmarks in the side nav: a saved view of a type's objects, or an object. `label` is a
-- snapshot for the nav (refreshed when the bookmarked page is shown), so it reads without loading.
CREATE TABLE bookmarks (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('view', 'object')),
  type_id    TEXT NOT NULL REFERENCES object_types(id),
  target_id  TEXT NOT NULL,            -- views.id or objects.id
  label      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_bookmarks_target ON bookmarks(target_id);

-- Sync (app/src/data/sync, shared/sync.ts). Local only, never replicated: every insert / update of
-- a synced table queues the row's key here, in the same transaction as the change. The sync
-- engine sends the queued rows and clears them. Rows the engine itself applies from the server
-- are not queued (it sets meta 'sync_applying' meanwhile). Files are immutable: insert only.
CREATE TABLE sync_outbox (
  id  INTEGER PRIMARY KEY,
  tbl TEXT NOT NULL,
  pk  TEXT NOT NULL            -- the row's id, or a JSON array of its key columns
);
CREATE TRIGGER sync_object_types_insert AFTER INSERT ON object_types WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('object_types', NEW.id); END;
CREATE TRIGGER sync_object_types_update AFTER UPDATE ON object_types WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('object_types', NEW.id); END;
CREATE TRIGGER sync_templates_insert AFTER INSERT ON templates WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('templates', NEW.id); END;
CREATE TRIGGER sync_templates_update AFTER UPDATE ON templates WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('templates', NEW.id); END;
CREATE TRIGGER sync_fields_insert AFTER INSERT ON fields WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('fields', NEW.id); END;
CREATE TRIGGER sync_fields_update AFTER UPDATE ON fields WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('fields', NEW.id); END;
CREATE TRIGGER sync_views_insert AFTER INSERT ON views WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('views', NEW.id); END;
CREATE TRIGGER sync_views_update AFTER UPDATE ON views WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('views', NEW.id); END;
CREATE TRIGGER sync_objects_insert AFTER INSERT ON objects WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('objects', NEW.id); END;
CREATE TRIGGER sync_objects_update AFTER UPDATE ON objects WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('objects', NEW.id); END;
CREATE TRIGGER sync_files_insert AFTER INSERT ON files WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('files', NEW.id); END;
CREATE TRIGGER sync_field_values_insert AFTER INSERT ON field_values WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('field_values', json_array(NEW.object_id, NEW.field_id)); END;
CREATE TRIGGER sync_field_values_update AFTER UPDATE ON field_values WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('field_values', json_array(NEW.object_id, NEW.field_id)); END;
CREATE TRIGGER sync_bookmarks_insert AFTER INSERT ON bookmarks WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('bookmarks', NEW.id); END;
CREATE TRIGGER sync_bookmarks_update AFTER UPDATE ON bookmarks WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('bookmarks', NEW.id); END;
