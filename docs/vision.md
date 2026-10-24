# Kubus vision

Where the product is going: one hub for native and remote data, and the roadmap.

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
- **Views and components are source-agnostic.** Table, cards, future per-record / query components
  and chart/dashboard view types render "items of a collection", wherever they come from. If remote
  data ever needs its own pages or its own query editor, the design has gone wrong.
- **Native vs remote:**

  | | Native Kubus | External / remote |
  |---|---|---|
  | Schema | user-defined | read from the source; only local labels / icons / column choices |
  | Editing | full | off by default; later only where a primary key allows it |
  | Offline | yes | no (maybe a read-only cached snapshot) |
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

Roadmap, in order: (1) native Kubus core: item links + backlinks, per-record and query components;
(2) the server + sync; (3) remote sources, read-only (tables and SQL queries through the server,
same views/components, links to remote rows); (4) editing remote data (Directus side), only where
the source allows it; (5) chart / dashboard view types (Metabase side), any time after (3).
Cheap step that can be done any time: introduce the capabilities type with the native source
declaring everything, and make the UI respect it.
