# Kubus vision

Where the product is going: one hub for native and remote data, the roadmap and every open item.

## Vision: one hub for all data

Obsidian + Metabase + Directus in one: personal knowledge, live external data and its
visualisation, linked together. The sharp pitch: *Obsidian, where your notes can embed and link
live data.* The unique part is linking across sources (a meeting note referencing live CRM rows,
a project page showing a query over production data next to your own notes).

Rules that keep this from becoming three products glued together:

- **Everything is a source with capabilities.** Native Kubus collections and remote data (external
  tables, SQL queries) are both "typed collections" behind one data-source interface. Each source
  declares what it supports, and the UI shows or hides features by those flags, never by source
  kind. Sketch:
  `{ edit, create, delete, editSchema, offline, serverQuery }`; the native source declares all.
- **Views and components are source-agnostic.** Table, cards, field and block components and
  (future) chart/dashboard block types render "items of a collection", wherever they come from. If remote
  data ever needs its own pages or its own query editor, the design has gone wrong.
- **Native vs remote:**

  | | Native Kubus | External / remote |
  |---|---|---|
  | Schema | user-defined | read from the source; only local labels / icons / column choices |
  | Editing | full | never: read-only by design |
  | Offline | yes | no |
  | Sync | yes | no, the source is its own truth |
  | Filter / sort / group | in memory (`applyQuery`) | pushed down to the server |
  | Links | both directions, backlinks | native → remote only |

- Links from native items to remote rows store source + table + key **plus a label snapshot**,
  so they read sensibly offline or after the row is gone.
- Settings for remote collections (column choices, labels, icons, views) are stored natively and
  synced; the remote data itself is never copied unless explicitly imported.
- Import (copy a CSV / query result into a new native collection) is the simple alternative to a live
  source and keeps the data editable and syncable.
- For SQL over the user's own data, generate a normal-looking SQL view per collection (pivoting
  the EAV `field_values`), so queries and query components don't have to deal with EAV.
- Remote sources make the server essential and change the security story: auth, secret storage
  for credentials, read-only database users by default.
- **Connect live state, copy histories.** A connector suits a live database worth querying: data that
  changes in place (balances, rows), a source that filters, sorts and pages for itself, or a generic
  store that opens many apps at once (Postgres, MySQL). An API that is a feed (only a recent window,
  like Spotify's last plays or an RSS feed), needs OAuth, or holds a history worth owning is better
  copied (n8n into Postgres / Influx, or native items through `/api/v1`). Most self-hosted apps have a
  REST API with a key and filtering: Kubus can be the hub that links a self-hoster's apps into notes.

## Roadmap

The stages, in order:

- **Native Kubus core**: item links (reference fields), field and block components. Built.
- **The server + sync** (docs/sync.md). Built.
- **Remote sources**, read-only: tables and SQL queries through the server, same views and
  components (docs/sync.md "Remote sources"). Built for Postgres, n8n data tables, InfluxDB 2 and Cloudflare D1. Remote data stays read-only by
  design (no Directus side).
- **Chart / dashboard block types** (Metabase side). Not started.

## Open items

Every open item, numbered (the other docs refer to them as "roadmap #n"). Nothing else in the docs
is planned work.

Native core:

1. Global search: a full-text index (today a substring scan), and search and the API (`/api/v1`)
   reading remote rows too.
2. Import a CSV or a query result into a new native collection (editable and synced, unlike a
   remote one).
3. A normal-looking SQL view per collection (pivoting `field_values`), for queries over the user's
   own data.
4. One capabilities type for every collection (`{ edit, create, delete, editSchema, offline,
   serverQuery }`), the native source declaring everything, with the UI asking it instead of
   `isRemote` (today only a remote source has capabilities, `SourceCapabilities.query`). Cheap; can
   be done any time.

Remote sources:

5. Links from native items to remote rows (source + table + key plus a label snapshot).
6. Remote queries behaving like local ones: text sorted in the app's numeric order ("Customer 9"
   before "Customer 10", not the source's collation), and counting a heavy query without running
   it in full.

Charts:

7. Chart / dashboard block types.

Local storage:

8. Export / import of the local database (sqlite file or JSON) for backups without sync.
9. The database opening everywhere: several browser tabs at once (a SharedWorker or Web Locks
    leader election; today a second tab shows an error), and OPFS verified in the macOS
    (WKWebView) and Linux (WebKitGTK) Tauri builds.
10. Rendering rows in steps ("show more") if a 5,000-item collection feels slow (not
    virtualization).

Sync:

11. Better merging: concurrent offline edits to the same Markdown field merge (a text CRDT such as
    Yjs) instead of one side being lost; equal timestamps on two devices converge; a device with
    data connecting to a server with data merges them (today the device's data is discarded).
12. Robustness: paged pulls, webhooks that survive a server restart (today best effort), and a
    device freeing space by dropping originals it has.

Views:

13. A calendar block type, for any collection with a date or date & time field (native or remote):
    month and year views with a dot per day that has items, a 24-hour bar per day, a week / day time
    grid. Moving to another period sets the block's date range, so a remote source sends only that
    period. Built from Carbon (no calendar library), overlapping items placed in lanes by a helper in
    `domain/`.
14. A timeline / Gantt block type: items as bars from a start to an end field, rows from a grouping
    or reference field, optional dependencies (a reference field to items of the same collection) and
    progress (a number field).
15. Dragging in the calendar and timeline blocks (move, resize, create), only where items can be
    changed (native collections whose fields are editable): an own pointer hook like
    `ui/useReorder.tsx`, or interact.js if touch gets hard.

New connectors, in this order (read-only like the others; queried by the source where it can, else in
`memory.ts`; each tested against a stand-in of its service or the real engine):

16. Groundwork. Secret parts of an address beyond its password (`splitPassword`,
    `server/src/settings.ts`): secret calendar addresses and published Google Sheets carry the secret
    in the path, API keys sometimes in the query string; a connector declares its secret parts and
    devices see the address without them (`webcals://calendar.google.com/…`), still dropped when the
    address changes. `string_list` in `memory.ts`. A shared `httpDocument.ts` for #19 and #20: one GET
    with `ETag` / `If-Modified-Since`, kept about a minute, the source's timeout, a size limit (about
    20 MB), status codes and content types turned into a clear problem.
17. Actual Budget through [actual-http-api](https://github.com/jhonderson/actual-http-api), not Actual
    itself (`@actual-app/api` needs `better-sqlite3` and Actual's core, holds one budget per process
    and must match the Actual server's version; the sync server's budget file is stale without its
    CRDT messages). `actual://host[:port]/<budget-sync-id>` (https) or `actual+http://…`, the API key
    as password (`x-api-key`); only GETs and `POST /v1/budgets/{id}/run-query` (ActualQL: filter,
    orderBy, groupBy, select, calculate, limit, offset), an "experimental" endpoint whose 501
    (`EXPERIMENTAL_OPERATIONS_ENABLED=false`) is the source's problem. Every request loads and syncs
    the budget: keep a read a few seconds. Curated tables: transactions (payee, category and account
    names), accounts (balance), categories (group), payees, schedules, budget months (month ×
    category: budgeted, spent, balance; queried in memory); amounts from cents, dates `yyyy-mm-dd`,
    split transactions with stable keys; no query language. An encrypted budget is the source's
    problem until a source can have a second secret (its encryption password).
18. MySQL / MariaDB, a dialect beside `postgresSql.ts` / `d1Sql.ts`: `mysql://user@host:3306/db`,
    `mariadb://…`, schemas are databases, driver `mysql2` (pure JS). Backtick quoting,
    case-insensitive collations, numeric text order and empty values last as the app has them,
    `TINYINT(1)` a checkbox, zero dates empty, `DATETIME` vs `TIMESTAMP` time zones, `JSON` / `BLOB` /
    `GEOMETRY` hidden or dropped. Every read in `START TRANSACTION READ ONLY`, a warning for a user that
    can write (`SHOW GRANTS`); timeout by `MAX_EXECUTION_TIME` (MySQL) or `max_statement_time`
    (MariaDB); a query is one `SELECT` / `WITH`. Tested on MySQL 8 and MariaDB (`KUBUS_TEST_MYSQL`).
19. Calendar (ICS) subscriptions: `webcal://` / `webcals://` and `ics+https://`, one calendar per
    source, table `events`, the address's path and query secret. `ical.js` parses; repeating events
    (`RRULE`, `EXDATE`, `RECURRENCE-ID`, `VTIMEZONE`) are expanded only within the filter's date range
    (else a year back and ahead, bounded by `MAX_ROWS`). Columns: title, start, end, all-day, start and
    end date (all-day events per day), location, description, status, categories, recurring; key: UID
    plus the occurrence's start. Later: CalDAV (editing), several calendars per source.
20. JSON and CSV over HTTP, the long tail without code per app (a published Google Sheet is CSV):
    `json+https://…`, `csv+https://…` (and `+http`), NDJSON detected. The rows are at the address's
    fragment read as a JSON Pointer (`…#/data/items`, never sent; none: the top level). The password
    goes as `Authorization: Bearer`, or under the address's user as header name
    (`json+https://X-Api-Key@host/…`). Paging by `Link: rel="next"` up to `MAX_ROWS`. Columns inferred
    from a sample (numbers, booleans, ISO dates and date & times, string arrays as lists, objects
    flattened one level, deeper ones a hidden text column). CSV: RFC 4180, a header row, the delimiter
    detected (`,` `;` tab), decimal commas only when the whole column has them; an own parser. Key: a
    column `id`, `uuid` or `key`, else the row's position (with a warning that links may break).

API:

21. Kubus as an MCP server over `/api/v1`, so an assistant (Claude or another MCP client) can read
    and write the knowledge base: tools for search, reading collections, items and a view's result,
    and creating and editing items, each a thin translation onto the same `/api/v1` routes (served by
    the headless device, never into Postgres; documented beside them in `app/src/help/api.md`).
    Remote MCP over streamable HTTP on the server, behind an API token (#22, so an assistant can be
    given one that only reads).
22. API tokens made in the app (Settings → Server), read or read & write, instead of the API using
    `KUBUS_TOKEN` (which stays the devices' token, with access to everything as now). A server-only
    table `api_tokens` (name, access, the token's SHA-256, created, last used; a migration in
    `server/src/migrations.ts`, not synced); a token is random (`kubus_…`) and shown once. An API token
    reaches only `/api/v1`; a read token only its `GET` / `HEAD` routes (every write, AI fields included,
    is another method). Tokens are listed, made and revoked by devices only (`/api/tokens`). Reading
    still runs the components already there (component values). Later: a token for one space, expiry.
