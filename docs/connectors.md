# Connectors

The next remote-source connectors (`server/src/connectors/`, docs/sync.md "Remote sources"): how they were
chosen and their design notes. The planned work itself is a numbered item in docs/vision.md ("roadmap #n"),
which points here for the details.

## How to choose

- **A connector when the source is a live database you want to query**: data that changes in place (balances,
  rows, albums), a source that filters, sorts and pages for itself, or a generic store that opens many apps at
  once (Postgres, MySQL, SQLite).
- **Copy (n8n into Postgres / Influx, or native items through `/api/v1`) when the API is a feed**: it only
  shows a recent window (Spotify, RSS, health samples), needs OAuth, retries and rate limiting, or holds a
  history you want to own. Histories you care about get copied; live state gets connected.
- The connector model is read-only: a source's tables with a key, filtered, sorted, grouped and paged a page
  at a time, by the source where it can (SQL, ActualQL) or in memory (`memory.ts`) where it can't.
- Positioning: most popular self-hosted apps have a REST API with an API key and filtering, exactly this
  model. Kubus can be the hub that links a self-hoster's apps into notes.

## The connectors (in this order)

### 0. Groundwork

- **Secret parts beyond the password.** `splitPassword` (`server/src/settings.ts`) only treats the address's
  password as secret. Secret calendar addresses (Google, iCloud, Outlook) and published Google Sheets carry
  the secret in the path, API keys sometimes in the query string. A connector declares its secret parts;
  devices see the address without them (`webcals://calendar.google.com/…`), and the "dropped when the address
  changes" rule still holds.
- **`string_list` in `memory.ts`** (JSON arrays of strings, calendar categories).
- **`httpDocument.ts`**, shared by ICS and JSON / CSV: one GET with `ETag` /
  `If-Modified-Since`, kept about a minute, the source's timeout, a size limit (about 20 MB), status codes and
  content types turned into a clear problem.
- Open: a second secret per source (Actual's budget encryption password). Without it, an encrypted budget is
  the source's problem ("encrypted budgets aren't supported").

### 1. Actual Budget, through actual-http-api

Not Actual itself: `@actual-app/api` needs `better-sqlite3` and all of Actual's core, holds one budget per
process and must match the Actual server's version. Its sync server isn't queryable (a budget file plus CRDT
messages), so reading its SQLite file would be stale. [actual-http-api](https://github.com/jhonderson/actual-http-api)
(community, one maintainer) carries all that in the user's own container and answers plain HTTP.

- Address `actual://host[:port]/<budget-sync-id>` (https), `actual+http://…`; the API key is the password
  (header `x-api-key`). Only GETs and `POST /v1/budgets/{id}/run-query`, never its write routes.
- `run-query` runs ActualQL (`filter`, `orderBy`, `groupBy`, `select`, `calculate`, `limit`, `offset`): the
  source filters, sorts and pages. It is an "experimental" endpoint (on by default; a 501 with
  `EXPERIMENTAL_OPERATIONS_ENABLED=false`): say so as the source's problem.
- Each request makes actual-http-api load and sync the budget: keep a read a few seconds, like n8n's.
- Curated tables, not the raw ones (tombstones, sort orders, integer dates, cents): transactions (with payee,
  category and account names), accounts (with balance), categories (with group), payees, schedules, and budget
  months (month × category: budgeted, spent, balance; from `/months/{month}/categories`, queried in memory).
- Amounts from cents to numbers, dates `yyyy-mm-dd`; split transactions with stable keys (`splits` chosen on
  purpose). No query language (`query: false`).
- Tested against a stand-in of actual-http-api, as n8n and InfluxDB are.

### 2. MySQL / MariaDB

The most common self-hosted database after Postgres (WordPress, Nextcloud, Home Assistant's recorder, Firefly
III, Monica). Mostly a dialect beside `postgresSql.ts` and `d1Sql.ts`.

- Address `mysql://user@host:3306/database`, `mariadb://…`; schemas are databases. Driver `mysql2` (pure JS,
  no native build in the server image).
- Backtick quoting; case-insensitive collations; numeric text order and empty values last as the app has them;
  `TINYINT(1)` a checkbox; zero dates (`0000-00-00`) empty; `DATETIME` vs `TIMESTAMP` time zones; `JSON`,
  `BLOB`, `GEOMETRY` hidden or dropped.
- Read-only: every read in `START TRANSACTION READ ONLY`; `check()` warns about a user that can write (`SHOW
  GRANTS`). Timeout: `MAX_EXECUTION_TIME` (MySQL) or `max_statement_time` (MariaDB), told apart in `check()`.
  Queries: one `SELECT` / `WITH`, wrapped as a subquery.
- Tested against both MySQL 8 and MariaDB (`KUBUS_TEST_MYSQL`, two service containers in CI).

### 3. Calendar (ICS)

Calendar subscriptions: the secret iCal address every calendar service offers. Live state (no copy needed),
and what a calendar block (roadmap) would show first.

- Address `webcal://` / `webcals://` (the standard scheme) and `ics+https://`; one source is one calendar,
  one table `events`. The address's path and query are secret (step 0).
- `ical.js` (Mozilla, pure JS) parses. Repeating events (`RRULE`, `EXDATE`, `RECURRENCE-ID` overrides,
  `VTIMEZONE`) are expanded only within the requested date range (from the filter, like n8n's
  `requiredRules`); without a date filter, a default window (a year back and ahead) bounded by `MAX_ROWS`.
- Columns: title, start, end (date & time), all-day, start date and end date (so all-day events filter per
  day), location, description, status, categories, recurring. Key: UID plus the occurrence's start, so a link
  to one occurrence holds.
- Tested with a fixture: a weekly series with an exception and a moved occurrence, an all-day event across a
  DST change, `ETag` caching.
- Later: CalDAV (editing), several calendars per source.

### 4. JSON and CSV over HTTP

The long tail without code per app. CSV is less rare than it looks: Google Sheets' "Publish to the web → CSV"
is a Sheets connector without OAuth, and open-data portals and app exports serve CSV.

- Address `json+https://…`, `json+http://…`, `csv+https://…`, `csv+http://…`; NDJSON detected.
- Where the rows are: the address's fragment as a JSON Pointer (`…/api/items#/data/items`; never sent to the
  server, so no new setting); none means the top level is the array.
- Auth with address and password only: no user sends `Authorization: Bearer <password>`; a user is the header
  name (`json+https://X-Api-Key@host/…` sends `X-Api-Key: <password>`). Keys in the query string are secret
  (step 0).
- Paging: `Link: <…>; rel="next"` up to `MAX_ROWS`; other styles only when a real source needs them.
- Columns from a sample: numbers, booleans (checkbox), ISO dates and date & times, arrays of strings
  (`string_list`), nested objects one level flattened (`author.name`), deeper ones a hidden text column.
- CSV: RFC 4180 (quotes, line breaks in quotes, BOM), a header row, the delimiter detected (`,` `;` tab), types
  inferred conservatively (`1,5` stays text unless the whole column is decimal-comma numbers). An own parser,
  no dependency.
- Key: a column `id`, `uuid` or `key`, else the row's position with a warning that links may break. One table
  (`rows`), queried in memory, GET only.
