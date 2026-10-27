-- Kubus database schema.
--
-- PRE-ALPHA: there are no migrations. When this file changes, the worker detects it (hash
-- stored in PRAGMA user_version) and creates the database afresh (local data is gone; a synced
-- device downloads it again).
--
-- Sync-readiness conventions (see CLAUDE.md):
--  * primary keys are client-generated UUIDs, never autoincrement
--  * every row carries updated_at (ISO 8601 UTC) for last-writer-wins merges
--  * deletes are soft (deleted_at tombstones) so they can be replicated
--  * field values are stored per (item, field) in typed columns, which maps
--    1:1 onto Postgres column types and allows field-level conflict resolution

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Separate environments (e.g. Work and Private) sharing collections and components: items,
-- collection views and bookmarks belong to one space and show only there (src/domain/spaces.ts). The default space
-- ('default') has a row only once it is renamed, like a collection's default item view.
CREATE TABLE spaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,               -- name of a Carbon icon, like a collection's
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,   -- singular, e.g. "Author"
  plural_name TEXT NOT NULL,   -- e.g. "Authors"
  icon        TEXT,            -- name of a Carbon icon (@carbon/icons-react export), e.g. "Book"
  description TEXT NOT NULL DEFAULT '',
  item_views  TEXT,            -- JSON [{ id, name, layout, isDefault }]: item page layouts (fieldLayout.ts)
  space_ids   TEXT,            -- JSON array of the spaces it is shown in; null = every space
  source      TEXT,            -- JSON { name, target, key, columns }: a remote collection's source (model.ts CollectionSource); null = its own items
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

-- Saved views of a collection's items (see src/domain/views.ts and src/views/registry.ts), per space.
CREATE TABLE views (
  id         TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  space_id   TEXT NOT NULL,            -- the space it is listed in (spaces.id; 'default' needs no row)
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,            -- JSON { filters, blocks } (domain/views.ts); block options validated by the block type
  position   INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,  -- the starred view, opened instead of "All" (at most one per collection and space)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_views_collection ON views(collection_id);

-- Shared components: Markdown with {{ JavaScript }} sections over the built-in $ names
-- (src/domain/components.ts). A field of kind 'component' shows the result (computed, never
-- stored); one of kind 'ai' sends it to a language model and stores the reply. Local components
-- (written in place) are stored with their place instead: fields.code, a block's options.
CREATE TABLE components (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL DEFAULT '',        -- Markdown with {{ JavaScript }} sections; $item is the current item
  output      TEXT NOT NULL DEFAULT 'markdown',  -- markdown | string | number | image | html (ComponentOutput)
  frame_ratio TEXT,                              -- html that fills its box: the box's shape on pages, e.g. '4/3' (null = 16/9)
  ai          INTEGER NOT NULL DEFAULT 0,        -- 1 = "AI prompt": the result is a prompt, for 'ai' fields
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE fields (
  id             TEXT PRIMARY KEY,
  collection_id  TEXT NOT NULL REFERENCES collections(id),
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'string', 'markdown', 'html', 'number', 'date', 'datetime', 'checkbox', 'image',
                   'item', 'string_list', 'checklist', 'item_list', 'component', 'ai')),
  -- for reference kinds: the collection whose items can be referenced
  target_collection_id TEXT REFERENCES collections(id),
  -- for 'component' / 'ai' fields: the shared component whose result the field shows (null: its own, in code)
  component_id   TEXT REFERENCES components(id),
  -- for reference kinds: JSON filter rules over the target's items limiting the choices (null = any)
  choice_filter  TEXT,
  -- for 'checkbox' / 'checklist' fields: an icon shown instead of the box (a key of TOGGLE_ICONS in ui/ToggleInput.tsx; null = the box)
  toggle_icon    TEXT,
  -- for 'checkbox' / 'checklist' fields: 1 = a checked one's text is struck through (null / 0 = not)
  strike_through INTEGER,
  -- for 'component' / 'ai' fields: its own (local) component, written in place: code, output and
  -- frame_ratio as in components (null code: the shared component_id). An 'ai' field always has an
  -- output: 'string' | 'number' | 'markdown', what its values are. Its component's rendered text is the
  -- prompt (domain/ai.ts); the value is stored in field_values like any other (value_text, or
  -- value_number), with a fingerprint of the prompt it came from in value_json: it is stale when that
  -- no longer matches.
  code           TEXT,
  output         TEXT,
  frame_ratio    TEXT,
  -- in a remote collection (collections.source): the source column it shows (null: a field of its own, a component field)
  source_column  TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  CHECK ((kind IN ('item', 'item_list')) = (target_collection_id IS NOT NULL))
);
CREATE INDEX idx_fields_collection ON fields(collection_id);
CREATE INDEX idx_fields_target ON fields(target_collection_id);

CREATE TABLE items (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  space_id      TEXT NOT NULL,         -- the space it belongs to (spaces.id; 'default' needs no row)
  item_view_id  TEXT,                  -- the item view (collections.item_views) this item is pinned to
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX idx_items_collection ON items(collection_id);

-- Binary content (images), content-addressed: id = SHA-256 of data, rows are immutable.
-- `data` and `unused_since` are local only (not synced columns). `data` NULL: this device knows
-- the file from a sync but hasn't downloaded its bytes yet (the sync engine fetches them; see
-- docs/sync.md). `unused_since`: when no live item used it any more (releaseFile in
-- SqliteRepository.ts); deleted a week later, here and on the server (sweepFiles).
CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB,
  created_at   TEXT NOT NULL,
  unused_since TEXT
);
CREATE INDEX idx_files_unused ON files(unused_since) WHERE unused_since IS NOT NULL;

-- A small version of an image file (shortest side 512 px), shown in table cells and cards; both
-- are `files` rows. Insert only, like files: the first link a server receives stays (another
-- device's own thumbnail of the same image is just as good). Released with its original.
CREATE TABLE thumbnails (
  file_id    TEXT PRIMARY KEY,   -- the original
  thumb_id   TEXT NOT NULL,      -- the thumbnail
  created_at TEXT NOT NULL
);
CREATE INDEX idx_thumbnails_thumb ON thumbnails(thumb_id);

-- Exactly one value_* column is used, determined by the field's kind.
-- Lists are JSON arrays in value_json (SQLite json_each / Postgres jsonb) and merge as one value.
CREATE TABLE field_values (
  item_id        TEXT NOT NULL REFERENCES items(id),
  field_id       TEXT NOT NULL REFERENCES fields(id),
  value_text     TEXT,     -- string, markdown (GFM)
  value_number   REAL,
  value_date     TEXT,     -- YYYY-MM-DD
  value_datetime TEXT,     -- ISO 8601 UTC
  value_bool     INTEGER,
  value_ref      TEXT REFERENCES items(id),
  value_file     TEXT,     -- files.id; no foreign key: a file's row can arrive later than its use
  value_json     TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (item_id, field_id)
);
CREATE INDEX idx_field_values_field ON field_values(field_id);
CREATE INDEX idx_field_values_ref ON field_values(value_ref);

-- Where each file is used: a row per file a value names (an image value, `files/<id>` in its
-- text). Local only and derived: the triggers keep it with every value written or applied from a
-- sync, through file_ids() (the engine defines it: shared/files.ts filesUsedBy). Whether a file is
-- in use (fileInUse in SqliteRepository.ts) is a lookup here, not a scan of the values.
CREATE TABLE file_uses (
  file_id  TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  field_id TEXT NOT NULL,
  PRIMARY KEY (file_id, item_id, field_id)
);
CREATE INDEX idx_file_uses_value ON file_uses(item_id, field_id);
CREATE TRIGGER file_uses_insert AFTER INSERT ON field_values BEGIN
  DELETE FROM file_uses WHERE item_id = NEW.item_id AND field_id = NEW.field_id;
  INSERT OR IGNORE INTO file_uses (file_id, item_id, field_id)
    SELECT value, NEW.item_id, NEW.field_id FROM json_each(CASE WHEN NEW.value_file IS NOT NULL OR instr(NEW.value_text, 'files/') > 0
                                                            THEN file_ids(NEW.value_file, NEW.value_text) ELSE '[]' END);
END;
CREATE TRIGGER file_uses_update AFTER UPDATE ON field_values BEGIN
  DELETE FROM file_uses WHERE item_id = OLD.item_id AND field_id = OLD.field_id;
  INSERT OR IGNORE INTO file_uses (file_id, item_id, field_id)
    SELECT value, NEW.item_id, NEW.field_id FROM json_each(CASE WHEN NEW.value_file IS NOT NULL OR instr(NEW.value_text, 'files/') > 0
                                                            THEN file_ids(NEW.value_file, NEW.value_text) ELSE '[]' END);
END;
CREATE TRIGGER file_uses_delete AFTER DELETE ON field_values BEGIN
  DELETE FROM file_uses WHERE item_id = OLD.item_id AND field_id = OLD.field_id;
END;

-- Bookmarks in the side nav: a saved view of a collection's items, or an item. `label` is a
-- snapshot for the nav (refreshed when the bookmarked page is shown), so it reads without loading.
CREATE TABLE bookmarks (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('view', 'item')),
  collection_id TEXT NOT NULL REFERENCES collections(id),
  space_id   TEXT NOT NULL,            -- the space it is listed in
  target_id  TEXT NOT NULL,            -- views.id or items.id
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
-- Its triggers (an insert and, unless insert only, an update trigger per synced table) follow
-- from shared/sync.ts: data/schema.ts adds them.
