-- Kubus server schema (Postgres): a readable replica of the app's synced tables.
-- Generated from shared/sync.ts, applied (idempotently) on server start.
-- No foreign keys or CHECKs: the server trusts clients and a partial push must never fail.
-- seq orders changes for pulling: every write takes the next value of sync_seq (server/src/sync.ts).
-- A column added to shared/sync.ts needs its ALTER line below (and in the CREATE TABLE).

CREATE SEQUENCE IF NOT EXISTS sync_seq;

CREATE TABLE IF NOT EXISTS object_types (
  id             text NOT NULL,
  name           text,
  plural_name    text,
  icon           text,
  description    text,
  object_views   jsonb,
  created_at     timestamptz,
  updated_at     timestamptz,
  deleted_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS plural_name text;
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS object_views jsonb;
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE object_types ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_object_types_seq ON object_types(seq);

CREATE TABLE IF NOT EXISTS templates (
  id             text NOT NULL,
  name           text,
  params         jsonb,
  code           text,
  output         text,
  frame_ratio    text,
  created_at     timestamptz,
  updated_at     timestamptz,
  deleted_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS params jsonb;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS output text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS frame_ratio text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_templates_seq ON templates(seq);

CREATE TABLE IF NOT EXISTS fields (
  id             text NOT NULL,
  type_id        text,
  name           text,
  kind           text,
  target_type_id text,
  template_id    text,
  template_args  jsonb,
  choice_filter  jsonb,
  toggle_icon    text,
  position       integer,
  created_at     timestamptz,
  updated_at     timestamptz,
  deleted_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE fields ADD COLUMN IF NOT EXISTS type_id text;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS target_type_id text;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS template_args jsonb;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS choice_filter jsonb;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS toggle_icon text;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS position integer;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_fields_seq ON fields(seq);

CREATE TABLE IF NOT EXISTS views (
  id             text NOT NULL,
  type_id        text,
  name           text,
  kind           text,
  config         jsonb,
  position       integer,
  is_default     integer,
  created_at     timestamptz,
  updated_at     timestamptz,
  deleted_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE views ADD COLUMN IF NOT EXISTS type_id text;
ALTER TABLE views ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE views ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE views ADD COLUMN IF NOT EXISTS config jsonb;
ALTER TABLE views ADD COLUMN IF NOT EXISTS position integer;
ALTER TABLE views ADD COLUMN IF NOT EXISTS is_default integer;
ALTER TABLE views ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE views ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE views ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_views_seq ON views(seq);

CREATE TABLE IF NOT EXISTS objects (
  id             text NOT NULL,
  type_id        text,
  object_view_id text,
  created_at     timestamptz,
  updated_at     timestamptz,
  deleted_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE objects ADD COLUMN IF NOT EXISTS type_id text;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS object_view_id text;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_objects_seq ON objects(seq);

CREATE TABLE IF NOT EXISTS files (
  id             text NOT NULL,
  mime           text,
  size           integer,
  data           bytea,
  created_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE files ADD COLUMN IF NOT EXISTS mime text;
ALTER TABLE files ADD COLUMN IF NOT EXISTS size integer;
ALTER TABLE files ADD COLUMN IF NOT EXISTS data bytea;
ALTER TABLE files ADD COLUMN IF NOT EXISTS created_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_files_seq ON files(seq);

CREATE TABLE IF NOT EXISTS field_values (
  object_id      text NOT NULL,
  field_id       text NOT NULL,
  value_text     text,
  value_number   double precision,
  value_date     date,
  value_datetime timestamptz,
  value_bool     boolean,
  value_ref      text,
  value_file     text,
  value_json     jsonb,
  updated_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (object_id, field_id)
);
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_text text;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_number double precision;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_date date;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_datetime timestamptz;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_bool boolean;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_ref text;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_file text;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS value_json jsonb;
ALTER TABLE field_values ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_field_values_seq ON field_values(seq);

CREATE TABLE IF NOT EXISTS bookmarks (
  id             text NOT NULL,
  kind           text,
  type_id        text,
  target_id      text,
  label          text,
  position       integer,
  created_at     timestamptz,
  updated_at     timestamptz,
  deleted_at     timestamptz,
  seq            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS type_id text;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS target_id text;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS position integer;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_bookmarks_seq ON bookmarks(seq);
