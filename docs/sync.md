# Sync with Postgres

The server, the sync engine, files, the HTTP API (headless device) and webhooks, and the
home-screen app.

## Sync with Postgres (the server and the sync engine)

Repo layout: `app/` the web app (what Tauri and the phone run), `desktop/` the Tauri shell,
`server/` the sync server (Node 24, runs its TypeScript directly, dependencies `pg` and
`@sqlite.org/sqlite-wasm` for the headless device), `shared/` what both sides import: `sync.ts`
the protocol (the list of synced tables / columns / types and the request shapes), `files.ts`
(file ids, `fileIdsIn`), `router.ts` (the routes of the server and the API), `api.ts` (types of the
server ↔ headless device interface).

**Topology.** `app ──HTTPS──> server ──> Postgres` (the example `docker-compose.yml` runs its own; any other via `DATABASE_URL`). The
client never talks to Postgres: browsers and the iOS PWA can only do HTTP. One container
(`server/Dockerfile`, `docker-compose.yml` with `DATABASE_URL` and `KUBUS_TOKEN`) serves the
sync API at `/api` and the built web app at `/`, so the phone installs the app from the server
(same origin, no CORS). Auth is one shared bearer token (`KUBUS_TOKEN`, the devices'; other tools get API tokens of
their own: "The API" below); the app's
Settings holds server URL + token + "Test connection" + Disconnect in the Server tab (`#/settings?section=server`,
`ui/ServerConnection.tsx`), and on/off + Download images + the wipes in the Sync tab (`#/settings?section=sync`,
`ui/SyncSettings.tsx`; reached from the "Configure sync" button in the popover of the status icon ending the top-right
tab strip, `ui/SyncStatusButton.tsx`, which itself only shows the state). Disconnect (forgets the server; the
device keeps its data and the next connection is a first one) + Wipe local database (`Repository.wipeLocal`:
pauses sync with `SyncControl.pause`, which keeps URL and token but forgets the server so switching it on again is a
first connection; then the worker drops every table and creates the schema afresh, and the app reloads) + Wipe server
database (while connected; `POST /api/wipe` with `{"confirm":"wipe"}`, `server/src/wipe.ts`: drops every table and sequence in
the server's schema, whatever they are, its own settings and API tokens included (a wipe is everything), and applies `schema.sql` again, in one transaction; then this device pauses sync, so
switching it on again uploads its data). A server whose database can't be migrated (`docs/migrations.md`: one migrated by a newer server, a synced column of another type) still starts: sync answers with that
error until the database is wiped. Per device (localStorage
`kubus.sync`). The replica in Postgres is readable (not end-to-end encrypted): the hub vision
needs server-side queries (docs/vision.md).

**Client** (`app/src/data/sync/SyncEngine.ts`, created by `SqliteRepository`, exposed as `repo.sync`):
- *Outbox by triggers.* `AFTER INSERT/UPDATE` triggers on every synced table (made from
  `SYNC_TABLES` and appended to `schema.sql` by `data/schema.ts`; insert only for `version: null`)
  queue the row's key in `sync_outbox` (local only), in the same transaction as the change; so no
  repository method knows about sync. Rows the engine applies from the server are not queued
  (`meta` row `sync_applying` is set during the apply). A new synced table or column goes in `schema.sql` and `shared/sync.ts`
  (`sync/spec.test.ts` fails until they agree); the triggers and the server's tables follow.
- *One request does push and pull*: `POST /api/sync { since, changes }` returns `{ cursor, changes }`
  (rows with server `seq` > since, but not the ones this request wrote: the device has them, and the
  cursor covers them). Applying the response, clearing the sent part of the outbox
  (`id <= snapshot`; edits made during the request stay queued) and storing `meta.sync_cursor` is
  one local transaction. Pulls are incremental (per row; `field_values` rows are single fields).
- *Merge*: a row replaces the local one only if its `updated_at` is newer (field-level last writer
  wins, since every value is its own row). Files and thumbnail links are immutable and inserted if
  missing. `now()`
  never goes below a timestamp received from the server (`observeStamp`), a cheap guard against clock
  skew instead of a hybrid logical clock.
- *First connection to a server* (or a changed server URL): the server is the source of truth. If it
  holds data, that replaces everything on the device (one local transaction, nothing is sent; the
  Server tab (saving a new address while sync is on) and the Sync tab (switching it on) ask for confirmation first, `isNewServer`). Only an empty server takes the device's data
  instead: all local rows are queued and uploaded.
- *Which database*: the server's database has an id (`server_meta`: a `gen_random_uuid()` and its
  creation time, inserted `ON CONFLICT DO NOTHING`, so a restart keeps it and a wipe, a new volume or
  another database gives a new one). Every response carries it (`SyncResponse.database`); the device
  keeps it in `meta` (`sync_database`) and sends it with every sync. When the server holds another
  one, it writes nothing and answers 409 (`SyncMismatch`, with whether the new database is empty):
  the outbox only holds what changed since the last sync, which would land there as fragments (and
  a non-empty server would then replace the data of the device that meant to fill it). The device
  pauses, keeping URL and token, and forgets the server; `SyncStatus.replaced` (kept in
  `kubus.syncReplaced` across reloads) turns the sync icon red, and its popover and the sync settings
  (`ui/ServerReplaced.tsx`) offer connecting again (`reconnect`): a first connection to the new
  database (download, after a confirmation; or upload when it is empty). Not caught: tables emptied by hand
  (the id stays) and a restored backup (same id, older data: devices ahead of the server pull
  everything again); delete the `server_meta` rows after such a restore to make it count as new.
- *When*: 2 s after a local write (a sync starting meanwhile takes it along and cancels that), every
  30 s, on `online`, when the app becomes visible, and when the server signals a change this device
  doesn't have (`GET /api/events`, server-sent events read with `fetch` so the token goes in a
  header; reconnects with backoff; each event is `data: <cursor>`, so a device's own push, at or
  below its cursor, doesn't make it sync again; `0` = wiped). Applied changes are announced as `DataChange`s, so every
  view refreshes as for a local write.

**Server** (`server/src`): `sync.ts` runs a request in one transaction under an advisory lock, so
`seq` (from `sync_seq`, taken per written row) order is commit order and a cursor never skips a row;
the lock also means the rows a request writes are exactly the ones after the cursor it started at,
which is how the answer leaves them out. Pushed rows are written a statement per table (and per
1000 rows: `jsonb_to_recordset`), not one by one. The synced tables are made from `shared/sync.ts`
(`schema.ts`: jsonb, timestamptz, …; no foreign keys or checks; added columns added), then `server/schema.sql` (the
server's own tables), all applied idempotently at start after the migrations (`server/src/migrations.ts`). Devices of
other versions: `SYNC_VERSION`, 426 and rows written in the columns they have (`docs/migrations.md`). `events.ts` is the change signal. Proxies must not
buffer `/api/events` (nginx: `proxy_buffering off`); polling covers a dropped stream. Its routes
(`index.ts`) go through the shared `Router` (`shared/router.ts`).

## Files

File bytes (images) never travel inside `/api/sync`; the synced `files` row is metadata only.
- *On a device* the bytes are the local-only column `files.data` (`spec.test.ts` allows it). `NULL`
  = known from a sync, not downloaded yet. A device without a server keeps every byte it stores.
- *Upload*: before a sync sends a queued `files` row, the engine asks `HEAD /api/files/<id>` and
  else uploads `PUT /api/files/<id>` (raw body, `Content-Type`); the server checks the SHA-256 against
  the id and the 20 MB limit (`MAX_FILE_BYTES`). Only then is the row sent, so the server never lists
  a file it can't serve. A sync uploads up to 50 MB / 30 s; the rest stays queued (and the engine
  syncs again at once), the other rows don't wait: image values have no foreign key
  (`field_values.value_file`), as a file's row may arrive after its use. A failed upload is retried
  at the next sync; a refused one (400/413) and one nobody has bytes for are dropped.
- *Download*: after each sync, in the background, three at a time (`downloadFiles`): thumbnails first,
  then originals; with the Sync setting "Download images: Full size when opened" (`SyncConfig.originals`
  = "opened") only thumbnails, an original then when `getFile` is first asked for it (and kept).
  `getFile` fetches missing bytes from the server. Files marked unused aren't downloaded.
- *Thumbnails* (`ui/thumbnails.ts`, `Repository.putThumbnail`): a copy with its shortest side 512 px
  (longest at most 2048), WebP, else JPEG or PNG, made in the browser when an image is stored or the
  first time one without a thumbnail is shown small (an image from the API: Node can't draw). Not for images already small (≤ 512 px or ≤ 100 KB), SVG or GIF. Stored as an ordinary file
  plus a row of the synced, insert-only `thumbnails` table (`file_id` → `thumb_id`; the first link the
  server gets stays, another device's own is as good). Used only by table cells, cards and compact
  component images (`useFileUrl(id, true)`); item pages, Markdown and the Lightbox (`data-file`) show
  the original. Released with the original.
- *On the server* the bytes are `file_bytes` (id, mime, data, stored_at), out of the sync tables
  (`server/src/files.ts`). `GET /api/files/<id>` sends them with a year-long private cache;
  `DELETE /api/files/<id>` drops them. Wiping drops them with every table. The server decides
  nothing about files: it stores, serves and deletes when a device says so.
- *Clean-up*, by the devices only. A value uses the files it names (an image value, `files/<id>` in
  its text, any field: `filesUsedBy` in `shared/files.ts`); triggers on `field_values` keep that in
  the local `file_uses` table (through the `file_ids()` function the engine defines). A file is in
  use when a live item, through a live field, uses it, a thumbnail through its original (`fileInUse`
  in `SqliteRepository.ts`). When an edit or a sync drops a file's last use, it is marked
  (`files.unused_since`, local only; `releaseFile`, same transaction; for a sync `filesUsedBefore`,
  read before the apply). `sweepFiles`, when the app opens and after each sync, unmarks the marked
  files used again and deletes those marked more than a week ago (`FILE_GRACE_MS`), with their
  thumbnail: first on the server (`SyncEngine.deleteFromServer`; one that fails stays for the next
  sweep), then here. A device that doesn't sync deletes only its own; the server's headless device
  (it keeps no files) never deletes the server's. Every synced device reaches the same answer from
  the same rows; the first to sweep deletes the server's copy, the others find it gone. The week
  covers a cut and paste across a save, late and out-of-order syncs, an offline edit. When pushed
  rows use a file the server no longer
  has, the answer lists it (`missingFiles`) and a device with the bytes queues it again.

## The server's settings

What a server offers beyond sync is set in the app: the language model in Settings → AI ("The server's",
`ui/AiSettings.tsx`), the remote sources in Settings → Connections (`ui/ConnectionSettings.tsx`) and the maps' style
in Settings → Maps (`ui/MapSettings.tsx`: one OpenFreeMap style for every Map block on every device, `MAP_STYLE_IDS`, Bright until one is chosen (`DEFAULT_MAP_STYLE`);
a device keeps the last one it heard in `kubus.mapStyle`, `app/mapStyle.ts`, asks the server once a map is shown, and
without a server, or with one of an earlier version that has no `map`, sets its own); each saves
its part on top of what the server holds then (`ui/useServerSettings.ts`). `GET` / `PUT /api/settings`
(`server/src/settings.ts`, types in `shared/settings.ts`) with the sync token; any device with the
token may change them. They are stored in the server's own table `server_settings` (JSON by key:
`ai`, `sources`, `map`; an update without `map`, from an earlier app, keeps it), never synced and dropped by a wipe (as are the API tokens, `api_tokens`: "The API" below). Secrets (the model's key, a source's password)
are write-only: a device sees `keySet` / `passwordSet`, never the value. A secret left out of an
update stays only while it would go to the same place (the same model address; a source's same kind
and the fields its password belongs to, `placeOf`: host, port and user, an address, an account): moved
elsewhere it is dropped, so whoever holds the token can't send a stored secret to a host of their
choosing. With `KUBUS_SECRET_KEY` set the secrets are stored
encrypted with it (AES-256-GCM, the key derived with scrypt; `kubus-sealed:v1:…`), so the database
alone (a dump, a backup) doesn't give them; without it they are stored as plain text, the owner's
choice, and the server says so in its log at start. Secrets stored as plain text are encrypted at
the next start with a key. One the key can't open (the key removed or changed) is kept as it is
but not used and reads as not set (the log names it): the right key brings it back, entering it
again replaces it. Saving applies at once: the model is used for the next
request, the sources' connectors are replaced and checked (`Sources.replace`), and the answer
carries each source's problem and warnings. The server's environment variables: `DATABASE_URL`,
`KUBUS_TOKEN`, `KUBUS_SECRET_KEY`, `PORT`, `STATIC_DIR`, `KUBUS_WEBHOOK_URL` and `KUBUS_WEBHOOK_SECRET`.

## The server's language model

Set in Settings → AI with "The server's" chosen (address, key, a model for AI fields and one for writing components):
`server/src/ai.ts` gives every device the same model. `GET /api/ai` says what is offered (`ServerAi`
in `shared/api.ts`: the models, never the address or key); `POST /api/ai/chat/completions` and
`GET /api/ai/models` forward to the provider with the server's key, for any device with the token.
In the app, Settings → AI → "The server's" (`AiConfig.source`, the default without a device's own)
points `createLlmClient` at `<server>/api/ai` with the sync token (`AiService.providerOf`; saving the
server's settings asks again, `serverChanged`); "My own" uses the device's own provider. The
headless device doesn't generate AI values (that stays with the apps).

## Remote sources (remote collections)

Databases the server reads for the devices, read-only, whose tables the app shows as
collections ("remote collections": `Collection.source`, `domain/sources.ts`). Set up in Settings →
Connections (a table of the connections; each one's dialog: name, kind, that kind's own fields, password, schemas, a
time limit). Remote collections are listed, added and edited on the Remotes page (side nav, once the server has a
connection), not on the Collections page (docs/features.md "Remote collections"). A source is stored as its kind and that kind's fields, its password beside them (no
connection string); its kind picks the connector, which reads the fields (`SourceConfig`). The server describes the
kinds and their fields (`server/src/connectors/kinds.ts`; `ConnectionKind` in `shared/settings.ts`, `GET
/api/settings` → `kinds`), so the app knows no database: PostgreSQL (host, port, database, user, TLS), n8n data tables
(address), InfluxDB 2 (address, organization), Cloudflare D1 (account ID, database ID), MySQL and MariaDB (host, port,
database, user, TLS), Actual Budget (address, budget sync ID, encryption password), Calendar (ICS) (address), JSON and CSV over HTTP
(address, rows at, query parameter, header name). Addresses are stored and shown as typed: a secret in one (a calendar's secret
path, a key in a query string, a published sheet's id) is written `{secret}` there and given as the source's
password, which fills it in. A kind can mark a field secret (`ConnectionField.secret`: a second secret, a budget's
encryption password): it is stored with the source's secrets (`StoredSource.secrets`, encrypted like the password),
never sent to a device (`GET /api/settings` says only which are set, `secretsSet`), set through the update's
`secrets` (left out: kept while the source's place stays, `placeOf`; a changed place drops it with the password) and
handed to the connector among its fields. Connectors that read one document over HTTP rather than a database (ICS, JSON, CSV) share
`connectors/httpDocument.ts`: one `GET`, kept a minute and then revalidated (`ETag` / `Last-Modified`), the source's
time limit, at most 20 MB, a status code or a web page where data was expected said in words; `webcal://` is read
over https. Sources were stored as
connection strings before; that format was dropped without a migration (a breaking change: such a source reads as
of no kind until it is set up again), and app and server must both be this version.
A renamed source keeps its former names (`formerNames`, by its stable id, never shown in the settings): requests by one
still reach it (`Sources.on`) and `GET /api/sources` lists them, so a collection made under an old name reads on and
takes the new one when its settings are opened. A source's name: letters, digits, spaces, `-` and `_`.
- *Protocol* (`shared/sources.ts`), connector-neutral, all behind the token:
  `GET /api/sources` (names, connector, capabilities, problem; never addresses),
  `GET /api/sources/<name>/tables`, `POST …/describe` (`{ target }`: a table → its
  columns as Kubus field types, the primary key, the columns not read), `POST …/query` (a page of
  rows for a view's query: its filter as one and / or tree of rules with plain values (`SourceCondition`,
  built by the app: the view's or page's filter with the block's on top; `conditionText` writes it in a
  connector's language, every rule bracketed; checked by `isSourceCondition` before a connector sees it), search, sort, grouping, the device's time zone,
  offset / limit, and with the first page the total and the groups' sizes; with `edges`, on the first page, the
  rows just outside a chart's date period, below), `POST …/row` (one row by its key).
- *Edges* (`SourceEdges`, `queryWithEdges` in `server/src/sources.ts`): a chart along a date field with a date
  period on it asks, with its first page, for the row with the latest date before the period and the one with the
  earliest after it (the same filter with the period moved just outside it, the search too). The server asks the
  connector for each as one more query beside the page (sorted by the column, one row); one it can't answer is none,
  never the page's error, and an older server just leaves `edges` out. Kept cheap per connector: SQL sources drop
  "empty last" from a sort when the filter keeps no empty value (`keepsOnlyValues`), so an index on the column gives
  the row; InfluxDB first asks the moment of the nearest point (`last()` / `first()`, from its index) and then reads
  only the days up to it (`isEdgeQuery`, `nearestFlux`, `edgeDays`; more days while the filter keeps none); n8n is
  asked its rows in that order a page at a time until the filter keeps one; the in-memory sources (Actual, JSON,
  CSV, calendars) have the rows already. A calendar's after-edge past 50,000 occurrences (a daily event for ever)
  is none.
- *Connectors* (`server/src/connectors/`): `Connector` (check, tables, describe, query, row, close),
  picked by the source's kind in `connectors/index.ts` (its fields listed in `connectors/kinds.ts`); another kind of source is another file there and
  nothing else changes. `Sources` (`server/src/sources.ts`) holds one per source and turns a
  connector's `SourceError` into 400, anything else into 502.
- *Postgres* (`connectors/postgres.ts`, SQL in `postgresSql.ts`, pure and tested without a
  database): every statement in a `READ ONLY` transaction with `statement_timeout`, on connections
  opened with `default_transaction_read_only`, using the extended protocol (one statement per query:
  a statement can't add another). Values
  are parameters and names quoted. Types map by `pg_type.typcategory` (`pgColumn`): numbers, booleans,
  `date`, `timestamptz` / `timestamp` (taken as UTC) as their field types; text, enums, `uuid`, `time`,
  network addresses as text; one-dimensional arrays as lists of strings; JSON, XML, intervals, ranges,
  composite and geometric values as text that is only filtered by contains / empty (`plain`: not
  sorted or grouped; JSON and XML hidden in a new collection's view); binary data, search indexes,
  PostGIS shapes and internals dropped. A filter means what the app's does (`applyQuery`): text
  case-insensitive, empty values last both ways, a date & time on its day in the device's time zone,
  comparisons kept to the column (so indexes are used), the key breaking ties so pages never overlap.
  A list column groups a row under each value. At start (and on every change) `check` warns about a
  superuser or a user that can write: give it a user that can only read (`GRANT SELECT`); the app only reads tables.
- *n8n* (`connectors/n8n.ts`): n8n's data tables through its public API, its address
  (https:// unless it says http://), the API key as the password (header `X-N8N-API-KEY`).
  Strictly read-only: its one request helper only sends `GET`s (`/data-tables`, `…/<id>/rows`); give
  it a key with only the read scopes (`dataTable:list`, `dataTableRow:read`) where
  n8n offers scopes. Tables only (no query language; `schema` null, a name two projects share gets
  its id: "Notes (<id>)"); "Schemas" lists project ids. Types: string as text, number, boolean as a
  checkbox, date as a date & time; then n8n's `id` (the key), `createdAt`, `updatedAt`. The API's
  filter is one flat and / or list with one sort and no counts, so the rows a query could keep are
  read (250 rows a request, by id, at most 100,000 rows; kept 5 s, so a view's pages and counts share
  a read) and queried in memory (`connectors/memory.ts`, pure: the same meaning as `postgresSql.ts`;
  text sorts as the app's, "Customer 9" before "Customer 10"; a list is filtered and sorted by its text and grouped under each value). n8n is sent, as its `filter`, the
  rules every kept row meets (not under an `or`) that it can narrow by: text contains / is (as
  `ilike`, ASCII only: n8n's SQLite folds only ASCII case), empty / not empty, numbers, dates by day
  (the lower bound a UTC day early: n8n on SQLite compares its stored "yyyy-mm-dd hh:mm:ss" as text
  with the ISO time sent); checkboxes are not sent. The search is sent when every searched column is
  text (n8n searches all of a table's own columns), an item page asks for its `id`. Whatever n8n
  returns is filtered exactly in memory, so a looser rule only reads more. Without a filter the whole
  table is read. The time limit bounds each request.
- *InfluxDB 2* (`connectors/influx.ts`, Flux in `influxFlux.ts`, pure and tested without a server):
  its address (http://host:8086, or https://; port 8086 / 443 by default) and organization, the token as the
  password; Flux over `/api/v2/query` (annotated CSV, `RFC3339Nano` times) with the time limit as the
  request's. Strictly read-only: the connector only ever sends Flux that reads; `check` warns when the token can write, or can read the
  server's tokens (likely an all-access one): give it a token that can only read its buckets.
  "Schemas" are buckets (system buckets `_…` left out); a table is a bucket's measurement, read as
  InfluxDB's UI shows it: all time (1970–2262), fields pivoted beside the tags, a row per series and
  time, told apart by the synthetic `_id` (`<time>,tag=value,…`, hidden; its key, read back on its
  moment alone). Columns: `_time`, the tags (`schema.measurementTagKeys`), the fields by the type of
  their latest value (`fieldColumns`): each field once (latest values of more than one type: a number when
  all are numbers, else text), and a field whose key a tag (or `_time`, `_id`) has too is named
  "<key> (field)" (then "(field 2)", …), renamed in the Flux before the pivot, so the tag keeps its
  name and both names stay the same on every read; CSV datatypes map to field types (`long`, `unsignedLong`, `double` numbers,
  `boolean`, `dateTime`; `duration` plain text; binary dropped). Filters, search, sort, grouping and paging are Flux piped onto the tables; days are
  worked out on the server, so a filter on `_time` narrows the `range()` read. Flux sorts all columns
  one way: numbers, times and checkboxes sorted the other way are negated, empty values get a marker
  column; groups are counted and ordered first and rows placed by their group's place (`dict`).
  Grouping by day uses `date.truncate` with a `timezone` location (InfluxDB 2.1 or later).
- *Cloudflare D1* (`connectors/d1.ts`, SQL in `d1Sql.ts`, pure and tested on SQLite itself:
  `d1Sql.test.ts`): its account ID and database ID, the password an API token, read over
  Cloudflare's HTTP API (`/raw`, one request per statement). Strictly read-only though D1 has no
  read-only mode: only statements the connector makes are sent (`SELECT`, `PRAGMA table_xinfo`;
  anything else is refused before it leaves), and a statement D1 reports as changing the database is an error. Still give it a token
  with D1 Read only (a token's permissions can't be checked from here). No schemas (a source's are
  ignored, with a warning). Types come from a table's declared types (SQLite's affinity words, plus
  `BOOL`, `DATE`, `DATETIME` / `TIMESTAMP`, `JSON` like Postgres's; `BLOB` dropped), else from a
  sample of the values; dates and dates & times may be text SQLite reads or Unix
  times (seconds or milliseconds), checkboxes 1 / 0 / true / yes. SQLite knows no time zones: a
  date & time's day in the device's zone uses the zone's offsets from 1990 to 2060 (`zoneOffsets`,
  computed with `Intl`). The time limit is the request's; filters on dates and numbers go through
  expressions (no index), text is case-insensitive for ASCII only (SQLite's `LIKE`).
- *MySQL / MariaDB* (`connectors/mysql.ts` over `mysql2`, a pool of 4; SQL in `mysqlSql.ts`, pure and tested
  without a server: `mysqlSql.test.ts`; `mysql.test.ts` on MySQL 8 and MariaDB): kinds MySQL and MariaDB, one
  connector (the server's `VERSION()` decides if they disagree, with a warning). Host, port, database (opened
  first), user, TLS; "schemas" are databases (the system's left out). Every read is one `START TRANSACTION READ
  ONLY` with the session's `time_zone` at `+00:00` and the time limit as `max_execution_time` (MySQL) or
  `max_statement_time` (MariaDB); statements are prepared (`?` parameters, backtick-quoted names, one statement
  each). `check` reads `SHOW GRANTS`: a superuser (`ALL` or `SUPER` on `*.*`) or a write privilege anywhere is
  warned about (a MySQL 8 role's privileges aren't listed there). Types from `information_schema.COLUMNS`:
  integers, decimals, floats, `YEAR` and `BIT(n)` numbers, `TINYINT(1)` / `BIT(1)` a checkbox, `DATE`, `DATETIME`
  (no zone: taken as UTC, like a Postgres `timestamp`) and `TIMESTAMP` (read in UTC) as dates & times, `ENUM`,
  `TIME`, text as text, `SET` a list (grouped under each member); `JSON` (MariaDB's: a `LONGTEXT` checked by
  `json_valid`) plain and hidden; binary, `BLOB`, spatial types and vectors dropped. Zero dates (`0000-00-00`,
  or a zero month or day) are empty. Text is compared lower-cased in `utf8mb4_bin` whatever the column's
  collation (case-insensitive, accents apart, as the app) and sorted in `utf8mb4_unicode_ci` with digit runs
  padded to 20 digits (`REGEXP_REPLACE`), so "Customer 9" comes before "Customer 10"; unlike the app, "e" and
  "é" tie (the key decides) and longer numbers sort by their text. Named time zones need MySQL's zone tables
  (often not loaded), so a day in the device's zone is worked out as D1's: filters compare the column with the
  day's UTC bounds (its index), grouping by day uses the zone's offsets. Numbers, dates and times are compared
  with the column itself; text, title and sort keys go through expressions (no index).
- *Actual Budget* (`connectors/actual.ts`): through [actual-http-api](https://github.com/jhonderson/actual-http-api),
  not Actual itself; its address (https:// unless it says http://) and the budget's sync ID, the API key as the
  password (`x-api-key`), the budget's encryption password a secret field (`budget-encryption-password`, sent only
  when set). Strictly read-only: only `GET`s and `POST …/run-query` (an ActualQL read) leave its one request
  helper. Curated tables, no query language (`schema` null), each keyed by `id`: Transactions (one run-query,
  account, payee, category and group names joined beside their ids; split transactions as their parts,
  `splits: "inline"`, each its own id with its split's `parent_id`; a transfer's payee is the other account),
  Accounts (`?include_balances=true`; an older actual-http-api: `…/balance` per account), Categories (with their
  group, from `/categorygroups`), Payees, Schedules (payee and account names, a range's middle as its amount,
  the recurrence in words), Budget months (month × category from `/months/<yyyy-mm>`: budgeted, spent, received,
  balance, carryover; key `<yyyy-mm>:<category id>`, the month a date on its first day). Amounts from cents to
  numbers, dates `yyyy-mm-dd`. Every request makes actual-http-api load and sync the budget (and it holds one at a
  time): requests go one at a time and a read is kept 5 s from when it is done. Queried in memory (`memory.ts`:
  ActualQL's text comparison, empty values and lack of time zones differ from the app's); only what narrows
  exactly is sent: the filter's required date bounds as run-query's `filter` (none before 1995, which ActualQL
  refuses), and only the months its required month rules keep are read (at most 240). Transactions need
  run-query: its 501 (`EXPERIMENTAL_OPERATIONS_ENABLED=false`) is a `check` warning and the source's problem when
  they are read. A budget actual-http-api can't open answers a bare 500, so its list of budgets (`GET /v1/budgets`)
  tells a wrong sync ID, or an encrypted budget (`encryptKeyId`) without its password or with a wrong one, in words;
  a refused key (403) likewise. No schemas.
- *Calendar (ICS)* (`connectors/ics.ts`, parsed by `ical.js`): one calendar per source, its address in clear
  (`webcal://`, `webcals://` or https; `httpDocument.ts`); a secret in it is written `{secret}` and filled in from
  the source's secret (`withSecret`, URL-encoded), else a set secret is sent as `Authorization: Bearer`. One GET,
  `text/calendar` (or `text/plain`, `application/octet-stream`); a document that isn't a calendar, or can't be
  parsed, is the source's problem. One table, `events` (schema null): title, start, end (dates & times, ISO UTC),
  all-day, start date and end date (dates: the days it starts and ends on in its own time zone; an all-day event
  has no start or end time, its end date is DTEND less a day), location, description, status, categories (a list),
  recurring, url, organizer, and the hidden uid and `id` (the key: UID and the occurrence's start,
  `uid@2026-03-01T08:00:00.000Z`, `uid@2026-04-01` all day). A row is an occurrence: repeating events (`RRULE`
  / `RDATE`, less `EXDATE`, `RECURRENCE-ID` overrides where they moved to, `RANGE=THISANDFUTURE`) are expanded
  over the days the filter's rules on start / end (start date, end date) leave, those every row meets (not
  under an `or`), a day's margin either way; else 20 years back and a year ahead of now. At most 50,000 rows (`MAX_ROWS`:
  past it, a problem asking for a shorter range); a repeating event is stepped through from its first
  occurrence, at most 200,000 steps (a minutely rule from long ago ends early). Single events are read
  whatever the dates. Times in the file's `VTIMEZONE`, else the `TZID` as an IANA zone, else (floating, or a
  zone neither defined nor known: `check` warns) as UTC. An item page's row is found by expanding around its
  key's start. The parsed calendar is kept with the document (a minute), its expansions per window. Then
  queried in memory (`memory.ts`). `check` warns about a calendar with no events, or events it can't read.
- *JSON and CSV over HTTP* (`connectors/json.ts`, `csv.ts`, what both share in `httpTable.ts`; pure parts tested,
  the connectors against a stand-in server): one table per source (JSON: named by "Rows at"'s last token, else `rows`;
  CSV: `rows`; any name is read, so a collection reads on when "Rows at" changes), read through `httpDocument.ts`
  (redirects followed: a published Google Sheet's CSV address answers with one) and its next pages by
  `Link: rel="next"` (at most 100 pages, 20 MB in all, `MAX_ROWS` 100,000 rows), queried in memory (`memory.ts`). The
  address is clear text; a secret in it is written `{secret}` and is the password (`withSecret`, URL-encoded). Else the
  password goes in the query under "Query parameter", under "Header name", or as `Authorization: Bearer`; only to the
  address's origin (a next page elsewhere is read without it). JSON: the rows at "Rows at" (a JSON Pointer, RFC 6901;
  empty: the top level), or NDJSON (by its content type, or a document whose every line is JSON); an object there is
  one row unless it holds lists of objects (then a problem naming them); objects in a row flattened one level
  (`address.city`), deeper ones hidden plain JSON text, a row that isn't an object one column `value`. CSV: RFC 4180
  by its own parser, a header row (an empty name becomes "Column 3", a repeated one "Name 2"), the delimiter
  `,` `;` or tab, whichever the header row has most of. Types inferred from all values: numbers (JSON's, or text
  without leading zeros or `+`, at most 15 digits; "1,5" only off a comma delimiter and with no dot in the column),
  booleans (JSON's, `true` / `false` in CSV), `yyyy-mm-dd` dates, ISO dates & times (UTC without a zone), arrays of
  scalars as lists, anything mixed as text. The key: a column `id`, `uuid` or `key` (any case) with its own value in
  every row, else the row's place (`_row`, hidden), which `check` warns about: a row's page and links to it change
  when rows are added above it.
- *App*: a block of a remote collection asks the source for its query (`useRemoteResult`, its Limit of rows
  a page (100 unless set; 0, a chart's unless set: every page, one after the other), "Show more"; search waits for typing to pause) instead of `applyQuery`; the item page reads
  its row by key (`rowKey` of the item id, a base64url of the key). Rows become items keeping their
  identity while unchanged. A page added after the first ("Show more", loading every row) only makes its own rows into
  items (`addRows`), so loading many pages costs as much as their rows; while every row loads, the block (a chart,
  a map: drawn anew each time) is given them at most once a second (`useThrottled`), and at once when done. Nothing is cached offline; the collection page's "Read again" asks again.
- *Known limits*: text sorts by the source's collation ("Customer 10" before "Customer 9"), not the
  app's numeric order (roadmap #6); counting a heavy query runs it in full (#6); references can't
  point at remote collections (#5); global search and the API (`/api/v1`) don't read remote rows
  (#1). InfluxDB: a measurement is read over all time unless filtered on `_time` (keep a
  `_time` filter on large buckets), two text sorts asked opposite ways sort the second the way of the
  first, and a field whose type differs between series can't be read with the others.

## The API (headless device) and webhooks

`/api/v1` (documented for users in `app/src/help/api.md`, the Help page's API tab) is answered by the
app's own `SqliteRepository` running inside the server process as one more synced device
(`app/src/headless`), never by writing to Postgres: so it follows the GUI's rules (field diffing,
file release, AI fields, the "All" view, soft deletes, change sets).
- *Device*: `DirectSqlClient` (in-memory sqlite-wasm, `SqliteEngine` as in the worker), the real
  `SyncEngine` with `memoryEnvironment({ keepFiles: false })` (settings in memory; file bytes dropped
  once uploaded, fetched from the server when asked), syncing over HTTP with `http://127.0.0.1:$PORT`
  and listening to `/api/events`. It starts with a first connection (everything but bytes). After a
  wipe (409) it wipes itself and connects again: it is a cache, it never uploads stale data.
- *Auth* (`server/src/tokens.ts`, types in `shared/tokens.ts`): the devices' `KUBUS_TOKEN` reaches everything, `/api/v1`
  too; other tools get an API token, made in Settings → API tokens (`ui/ApiTokens.tsx`, shown once in a dialog with a copy
  button): `kubus_` + 32 random bytes (base64url), with a name and an access, `read` or `write` (read & write). The server
  keeps only its SHA-256 (hex), in its own table `api_tokens` (`server/schema.sql`), never synced, dropped by a wipe (a tool needs a new token afterwards). An API token reaches only `/api/v1`
  (and its MCP server): anything else under `/api` (sync, events, files, settings, the model, sources,
  `/api/tokens`, wipe) answers 403; a read token only `GET` / `HEAD`, every write (AI fields included) another method,
  403 saying so. A token's last use is written at most once a minute (per server process). Devices list, make and
  revoke them: `GET /api/tokens` (`ApiTokenInfo[]`, no token), `POST /api/tokens` `{ name, access }` (201,
  `ApiTokenMade`: the token, this once), `DELETE /api/tokens/<id>` (404 for an unknown one). `ApiTokens.check(header)`
  answers who a request's `Authorization` is (`{ access: "all" | "read" | "write" }` or null), for the server and for
  endpoints of its own (MCP); `allows(access, method)` is the read rule. Revoking takes effect at the next request.
- *Requests* run one at a time (`HeadlessDevice.serial`); each syncs first unless the device is
  already at the server's latest write (`HeadlessOptions.cursor`, which the server knows: reads see
  the latest data without a request), and a write syncs again before it answers.
- *Routes* (`headless/api.ts`): each a thin translation onto one `Repository` method; names by id or
  name (`values.ts`: values by field name, checked per kind; component values included, read only,
  computed with `refLabelForSpace` as the screens and the AI backfill do). File bytes
  (`GET /api/v1/files/<id>`) come from the server's own handler. Errors `{ error }` 400 / 404 / 409 /
  503.
- *Component code* runs there in a V8 context of its own (`headless/compiler.ts` via `setCompiler`):
  no Node globals, no `eval`, 1 s per section. Not a security boundary: whoever holds the token can
  run code on the server.
- *Build*: `npm run build:headless` (`app/vite.headless.config.ts`, an SSR build) bundles
  `app/src/headless/index.ts` into `server/headless/index.js` (git-ignored; the Dockerfile's web stage
  builds it); sqlite-wasm stays external. The server loads it with a dynamic import
  (`server/src/headless.ts`); without it `/api/v1` answers 503 saying to build it.
- *Webhooks* (`headless/webhooks.ts`): `SyncEngine.onPulled` reports each sync's applied rows and
  the ones it sent (the API's own writes, which the server doesn't send back); the device turns them into events (item created / updated / deleted with the item as the API returns
  it; collection, view, space, component, bookmark changed) and POSTs one payload per sync to each of
  `KUBUS_WEBHOOK_URL` (comma-separated), signed with `KUBUS_WEBHOOK_SECRET` (`X-Kubus-Signature:
  sha256=<HMAC>`). Created = first seen by the hook. In order per URL, retried after 1, 5, 30 s, then
  dropped and logged; nothing survives a restart. The first download isn't sent.
- *MCP* (`server/src/mcp.ts`): `POST /api/v1/mcp` is a remote MCP server (streamable
  HTTP, protocol 2025-11-25 / 2025-06-18 / 2025-03-26) for assistants. Stateless (no session id),
  JSON answers, no SSE (GET: 405); a notification or response gets 202; batches only in 2025-03-26;
  an `Origin` other than the server's own (`Host` / `X-Forwarded-Host`) gets 403. Its tools (search,
  spaces, collections, items with filters and sort, views and a view's result; create, update and
  delete an item) each build an `ApiRequest` for one `/api/v1` route and call `handleApi`, as an HTTP
  caller would: nothing of its own reaches the device or Postgres. `handleMcp` takes the caller's
  `Access` (`ApiTokens.check` in `index.ts`: `KUBUS_TOKEN` is `"all"`, an API token its own; the read rule
  by method doesn't apply, every MCP request being a `POST`); with `"read"` the tools that write are neither
  listed nor run. An API refusal is a tool result with `isError` (the model can act on
  it), an unknown tool or one the token may not use a JSON-RPC error.

**iOS / home-screen app.** The same web build. Status bar: no style meta (`default`); iOS
colours the bar from the top tab strip (sticky, solid, full width; see Conventions). `body` is
fixed and only pane bodies scroll, no bounce or zoom; the workspace is `position: fixed; inset: 0`.
Files: `app/public/manifest.webmanifest`, apple-touch-icon (its href gets a content hash at build, `vite.config.ts`; iOS never refreshes an installed icon, so a changed icon only shows after removing and re-adding the app) and
meta tags in `app/index.html`, safe-area padding in `styles.css`, and a service worker (`app/sw.js`,
emitted by the build with a version stamp; `platform/serviceWorker.ts` registers it in production
web builds only) that caches the app shell, so it starts offline. iOS needs HTTPS for OPFS and
service workers: put the container behind a TLS proxy or tunnel (Caddy, Tailscale serve, Cloudflare
tunnel). The Tauri app (https origin) can only sync with an HTTPS server too.

**Known limits** (the planned ones are numbered in docs/vision.md, "Open items"):
- Last writer wins per field; concurrent offline edits to the *same markdown field* lose one side
  (roadmap #9). Equal timestamps on two devices don't converge (#9).
- A pull is not paged (#10). Webhooks are best effort, lost on a restart (#10). A device never frees
  space by dropping originals it has (#10). A device that still shows an image deleted elsewhere
  only lacks it until its next sync brings the edit that removed it. An image is lost only when a
  device offline for over a week adds a use of it itself (a paste, or an edit of an old copy of the
  text winning last-writer-wins) without having its bytes (possible only with "Full size when
  opened" and the image never opened); with the bytes, it uploads them again (`missingFiles`). A
  device that sweeps while sync is off leaves the server's copy (another device's sweep deletes it).
- One user: the devices share one token; API tokens are per tool, but reach every space (a token for one space, and
  expiry, are later: roadmap #15). Reading through the API runs the components already there (component values), so a
  read token runs code on the server too. A device
  that is not synced can lose its data on a schema wipe; with the server the replica re-syncs, so
  enable sync before putting real notes in. Connecting a device that has data of its own to a
  server that has data too discards the device's data, no merge (#9).
