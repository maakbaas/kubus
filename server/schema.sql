-- Kubus server schema (Postgres): the server's own tables. The synced tables come from
-- shared/sync.ts (server/src/schema.ts makes them and runs this after them); all of it is applied,
-- idempotently, at every start, after the migrations (server/src/migrations.ts, recorded in its
-- table schema_migrations). A change to a table here is a migration (CREATE ... IF NOT EXISTS
-- doesn't change one that exists).
-- seq orders changes for pulling: every write takes the next value of sync_seq (server/src/sync.ts).

CREATE SEQUENCE IF NOT EXISTS sync_seq;

-- Which database this is: a random id made with it (never changed; a wipe drops this table and
-- makes a new one) and when, for people. Devices compare the id to tell a wiped or replaced
-- database from the one they synced with (server/src/sync.ts).
CREATE TABLE IF NOT EXISTS server_meta (
  key            text NOT NULL,
  value          text NOT NULL,
  PRIMARY KEY (key)
);
INSERT INTO server_meta (key, value) VALUES ('database_id', gen_random_uuid()::text) ON CONFLICT (key) DO NOTHING;
INSERT INTO server_meta (key, value) VALUES ('created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT (key) DO NOTHING;

-- File bytes, not synced as rows: devices upload them (PUT /api/files/<id>) before the `files`
-- row that lists them, download them separately, and delete them once no item has used them for a
-- while (server/src/files.ts). id = SHA-256 of data.
CREATE TABLE IF NOT EXISTS file_bytes (
  id             text NOT NULL,
  mime           text NOT NULL,
  data           bytea NOT NULL,
  stored_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- The server's own settings (Settings → AI and Connections in the app; server/src/settings.ts): the
-- language model it offers and the sources it reads, as JSON by key ('ai', 'sources'), secrets
-- included. Never synced or sent to a device; dropped by a wipe like everything else.
CREATE TABLE IF NOT EXISTS server_settings (
  key            text NOT NULL,
  value          jsonb NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key)
);

-- API tokens (Settings → API tokens in the app; server/src/tokens.ts, types in shared/tokens.ts): each
-- reaches only /api/v1 (and the MCP endpoint), to read ('read': GET / HEAD) or also to write
-- ('write'). The token itself is shown once and never stored, only its SHA-256 (hex). Never synced;
-- dropped by a wipe, like server_settings.
CREATE TABLE IF NOT EXISTS api_tokens (
  id             text NOT NULL,
  name           text NOT NULL,
  access         text NOT NULL,
  token_sha256   text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  PRIMARY KEY (id)
);
