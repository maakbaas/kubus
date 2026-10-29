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
  the chart block (and future dashboards) render "items of a collection", wherever they come from. If remote
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
  for credentials (a source's password and the model's key are write-only and, with `KUBUS_SECRET_KEY`
  set, stored encrypted; `docs/sync.md`), read-only database users by default. Three things are
  easily mixed up: `KUBUS_TOKEN` is the devices' shared token for sync and everything else (an environment
  variable, not stored in the database); `KUBUS_SECRET_KEY` only encrypts the stored secrets at rest;
  API tokens (made in the app, read or read & write, `api_tokens`) reach only the API and its MCP server.
- **Connect live state, copy histories.** A connector suits a live database worth querying: data that
  changes in place (balances, rows), a source that filters, sorts and pages for itself, or a generic
  store that opens many apps at once (Postgres, MySQL). An API that is a feed (only a recent window,
  like Spotify's last plays or an RSS feed), needs OAuth, or holds a history worth owning is better
  copied (n8n into Postgres / Influx, or native items through `/api/v1`). Most self-hosted apps have a
  REST API with a key and filtering: Kubus can be the hub that links a self-hoster's apps into notes.

## Roadmap

The stages, in order:

- **Native Kubus core**: item links (reference fields, links in Markdown), backlinks (the virtual Backlinks collection of an
  item page's blocks, read from the synced `item_links` index: docs/features.md "Backlinks"), field and block components. Built.
- **The server + sync** (docs/sync.md). Built.
- **Backup**: the local database downloaded as a SQLite file and restored from one (Settings → Backup,
  docs/sync.md "Backup and restore"). Built.
- **Remote sources**, read-only: tables and SQL queries through the server, same views and
  components (docs/sync.md "Remote sources"). Built for Postgres, MySQL / MariaDB, n8n data tables, InfluxDB 2,
  Cloudflare D1, Actual Budget, calendar (ICS) subscriptions and JSON / CSV over HTTP. Remote data stays read-only by
  design (no Directus side).
- **Chart / dashboard block types** (Metabase side). The chart block is built (docs/views-and-workspace.md
  "Block types"), and so is reading several collections as one in a dashboard's block (native and remote mixed, fields merged by name or by hand,
  paging, groups, totals and charts over all of them: docs/features.md "Several collections in one block"), so one chart can total two
  sources. Dashboards are built too (docs/features.md "Dashboards": pages of blocks of any collections, in tabs per space, with one
  filter whose Date steps every dated block), and their blocks stand side by side in rows (docs/features.md "Blocks side by
  side").

## Open items

Every open item, numbered (the other docs refer to them as "roadmap #n"). Nothing else in the docs
is planned work. A finished item is removed and its number not reused (#7, backup, is built: Settings → Backup).

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

Local storage:

8. The database opening everywhere: several browser tabs at once (a SharedWorker or Web Locks
    leader election; today a second tab shows an error), and OPFS verified in the macOS
    (WKWebView) and Linux (WebKitGTK) Tauri builds.

Sync:

9. Better merging: concurrent offline edits to the same Markdown field merge (a text CRDT such as
    Yjs) instead of one side being lost; equal timestamps on two devices converge; a device with
    data connecting to a server with data merges them (today the device's data is discarded).
10. Robustness: paged pulls, webhooks that survive a server restart (today best effort), and a
    device freeing space by dropping originals it has.

Views:

11. A calendar block type, for any collection with a date or date & time field (native or remote):
    month and year views with a dot per day that has items, a 24-hour bar per day, a week / day time
    grid. Moving to another period sets the block's date range, so a remote source sends only that
    period. Built from Carbon (no calendar library), overlapping items placed in lanes by a helper in
    `domain/`.
12. A timeline / Gantt block type: items as bars from a start to an end field, rows from a grouping
    or reference field, optional dependencies (a reference field to items of the same collection) and
    progress (a number field).
13. Dragging in the calendar and timeline blocks (move, resize, create), only where items can be
    changed (native collections whose fields are editable): an own pointer hook like
    `ui/useReorder.tsx`, or interact.js if touch gets hard.

Remote sources, later:

14. Calendars over CalDAV (editing, several calendars per source), beside the read-only ICS subscriptions.

API:

15. API tokens for one space, and tokens that expire; OAuth for MCP clients that can't send a header
    (claude.ai's connectors), and allowed origins for browser-based ones.

Charts:

16. A value axis's min and max only framing the chart. Carbon Charts leaves out every data point
    outside an axis's `domain` (`getAllDataFromDomain` in its model), so a bar above the max vanishes
    instead of reaching the top, and a line skips the value. Keeping them means changing Carbon's
    behaviour: the value axes left out of that filter, and the plot clipped by hand (Carbon draws
    this chart without a clip, and dots never clipped), so a bar below the min doesn't cover the axis.
    Parked: not worth patching Carbon's internals for now.
17. (done: blocks side by side, docs/features.md "Blocks side by side")

