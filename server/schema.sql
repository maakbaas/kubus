-- Kubus server schema (Postgres): the server's own tables. The synced tables come from
-- shared/sync.ts (server/src/schema.ts makes them and runs this after them); all of it is applied,
-- idempotently, at every start.
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
-- row that lists them, and download them separately (server/src/files.ts). id = SHA-256 of data.
CREATE TABLE IF NOT EXISTS file_bytes (
  id             text NOT NULL,
  mime           text NOT NULL,
  data           bytea NOT NULL,
  stored_at      timestamptz NOT NULL DEFAULT now(),
  -- When the file lost its last use (or was uploaded without one); NULL while in use. Deleted
  -- once that is longer ago than the grace period (server/src/files.ts).
  unused_since   timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE file_bytes ADD COLUMN IF NOT EXISTS unused_since timestamptz DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_file_bytes_unused ON file_bytes(unused_since) WHERE unused_since IS NOT NULL;

-- Where each file is used: a row per file a stored value names (shared/files.ts filesUsedBy),
-- kept by every sync request for the values it writes, as devices keep theirs. Whether a file is
-- in use (shared/files.ts fileInUse) is a lookup here.
CREATE TABLE IF NOT EXISTS file_uses (
  file_id        text NOT NULL,
  item_id        text NOT NULL,
  field_id       text NOT NULL,
  PRIMARY KEY (file_id, item_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_file_uses_value ON file_uses(item_id, field_id);
CREATE INDEX IF NOT EXISTS idx_thumbnails_thumb ON thumbnails(thumb_id);
-- Servers from before file_bytes kept the bytes in files.data: moved here, then the column goes.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'files' AND column_name = 'data') THEN
    INSERT INTO file_bytes (id, mime, data)
      SELECT id, coalesce(mime, 'application/octet-stream'), data FROM files WHERE data IS NOT NULL
      ON CONFLICT (id) DO NOTHING;
    ALTER TABLE files DROP COLUMN data;
  END IF;
END $$;

