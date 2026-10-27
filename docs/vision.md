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

## Roadmap

The stages, in order:

- **Native Kubus core**: item links (reference fields), field and block components. Built.
- **The server + sync** (docs/sync.md). Built.
- **Remote sources**, read-only: tables and SQL queries through the server, same views and
  components (docs/sync.md "Remote sources"). Built for Postgres. Remote data stays read-only by
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
