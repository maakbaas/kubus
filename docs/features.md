# Kubus features

What the app does, feature by feature (moved out of CLAUDE.md; read the part you work on).

## Goals

- **User-defined schema.** Users create collections (e.g. Book, Person, Meeting) with arbitrary
  fields, and CRUD both the collections and their items.
- **Field types:** String, Markdown, HTML (source edited in the component code editor, shown in the
  sandboxed `HtmlFrame` like a component's HTML output; its text in tables, cards and search; the
  frame reports clicks on plain content, which start editing, while links, controls, canvas/svg
  and elements with handlers keep their clicks), Number, Date, Date & time, Checkbox, Image, Item (reference
  to an item of another collection, e.g. Book → Author), List of strings, Checklist (items with a
  checkbox, stored as GFM task lines "[x] text", `domain/checklist.ts`; tables show "2/5"),
  List of items, Component (computed from a component), AI (written by a language model from a prompt).
- **Checkbox and Checklist fields can show an icon instead of the box** (`fields.toggle_icon`, a
  key of `TOGGLE_ICONS` in `ui/ToggleInput.tsx`: heart, star, flag, bookmark, checkmark, thumbs up,
  faces; outlined when off, filled when on; null = Carbon's checkbox). Every place that toggles
  such a value uses `ToggleInput`, never `Checkbox` directly. Markdown task boxes stay GFM boxes.
- **Markdown is strictly GitHub Flavored Markdown.** The Milkdown editor (`app/src/ui/MarkdownEditor.tsx`)
  loads only the CommonMark + GFM presets (plus non-syntax utilities: history, listener,
  clipboard, upload, prism). Don't add syntax plugins (math, emoji, diagrams, frontmatter, Crepe, …),
  and any future renderer must also be GFM-only. Behaviour-only additions are fine: clickable task
  checkboxes, typed `[text](url)` links, link hover popover (open/edit/remove), code coloring
  (refractor common languages), images via button/paste/drop stored as `files/<sha256>` URLs. `{{ }}` sections (JavaScript, see Components) are kept out of the editor: swapped for tokens before loading, shown as chips (an inline atom node) edited from a code dialog, written back raw (`ui/markdownSections.ts`; typed or pasted `{{ … }}` become chips), so Markdown never reads or escapes the code.
- **Collections have a singular and plural name** ("Author" / "Authors"): singular for one item
  ("New Author"), plural for lists, navigation and counts (`countLabel`).
- **Items are edited in place**: `#/collections/<id>/items/<itemId>` shows every field in the
  user's order; clicking a field turns it into its form input, with no buttons (they would push the
  content down). Enter saves (Ctrl/Cmd+Enter in markdown), clicking outside saves, Escape cancels;
  checkboxes save on toggle; markdown starts editing where it was clicked. View and edit mode must
  keep the same geometry (label spacing, box height, text position) so nothing jumps. The field
  that is the item's title (`labelField`) isn't repeated among the fields: the page title itself
  is its editor (click to edit in place). The full form
  (`…/items/new`) is only for creating. Narrow screens show the items list as cards.
- **Markdown editor has no toolbar**: formatting is typed, images pasted/dropped, links edited from
  their hover popover. Its height follows the content (no inner scrolling, no resize handle).
- **Collection editor header is the editor** for the collection's icon (button + popover picker) and name
  (heading-sized input).
- **Collections have an icon** from the full Carbon set (`collections.icon`, an `@carbon/icons-react`
  export name). The icon module is lazy-loaded (`app/src/ui/collectionIcons.tsx`); the picker is a search
  box over a grid of matches. App icon: `app/public/favicon.svg` (isometric cube, three shades of Carbon blue, transparent background),
  rendered to `desktop/icons` with `tauri icon` (`--ios-color '#d0e2ff'`); the PWA's icon-1024, the apple-touch-icon (iOS home screen) and the Tauri iOS icons are the cube at 70% on #d0e2ff (a blue lighter than the cube's lightest), rendered from `favicon.svg`. Display name: Kubus (app identifier `com.kubus.app`; changing it, or the database / pool
  names, the lock or the `kubus.*` storage keys, orphans existing data).
- The Milkdown editor reports changes synchronously (`changes` plugin); don't switch back to the
  debounced listener plugin, which lost text typed right before saving.
- **Components** (`#/components`, `app/src/domain/components.ts`, table `components`, field kind
  `component`): Markdown with `{{ … }}` sections of JavaScript over `$variables` (stored as
  `params`), plus the built-ins `$now` / `$item` (the item itself, n8n style) and, in a block,
  `$items` / `$groups` / `$fields` / `$all` (details in the header of `components.ts`). A Component field picks one (`fields.component_id`) and maps each
  variable to a field of its collection or a fixed text/number (`fields.component_args`, `ComponentArg`),
  so one component serves any collection. A component that is only `{{ … }}` yields that raw value
  (numbers sort as numbers); otherwise rendered Markdown (rendered on item pages, plain text in
  tables/cards). Results are computed whenever items are shown (`withComputed`, before queries
  run) and never stored; failing sections show `⚠ message`. One concept on purpose: the same
  components are fields and blocks (see Blocks). The code runs in the app with the
  user's rights (`new Function`); it must move to a sandbox once components can come from others
  (sync, sharing).
  - `{{ }}` sections also work inside an item's own string, markdown, HTML and number values
    (`withComputed` renders them when shown and keeps the typed source in `item.sources`, which
    editors use). A number field holding sections stores that text in `value_text`, so its input
    is a Carbon TextInput with a decimal keyboard (NumberInput takes no braces).
  - HTML output renders in a sandboxed frame that sizes itself, one component for every place
    (`HtmlFrame` in `ui/ComponentValue.tsx`, which documents flow/fill sizing, `frame_ratio`, the
    `<meta name="frame">` override and the zero-specificity base styles).
  - Components see an image field as its src, `files/<sha256>`: Markdown and image outputs (and
    card covers) resolve it to the stored file; HTML frames get each file embedded as a data URL.
  - A component field on an item page is edited in place like any field: clicking it edits its
    component's code (`ui/ComponentFieldEditor.tsx`); saving asks first, as the change applies
    everywhere the component is used (Change component /
    Discard changes, which reverts / Keep editing, also on × or Escape).
  - What a component uses decides where it can go (`componentUses`): `$item` = needs an item
    (a field, a block on an item page; never offered on a collection view); `$items` / `$groups` /
    `$fields` = lists a block's items (its block then offers filter, sort, fields); neither = static
    content. A block's variables take a fixed value or a field of the block's collection, passed
    as the field's name (which field to use), not a value.
  - Fields can also be added from every field picker ("Add field": table columns, card fields,
    item page layout; `ui/FieldModal.tsx`, which also edits component fields). They are ordinary
    fields of the collection, shown in the picker's own view; adding asks for confirmation (the field
    belongs to the collection, not the view).
- **AI fields** (`app/src/domain/ai.ts`, field kind `ai`, `fields.ai_prompt` / `ai_output`; model plumbing in
  `app/src/app/ai.ts`, `platform/llm.ts`): a field whose value a language model writes per item. The prompt is written
  like a component (`{{ $item.Artist }}`); only `$item` exists in it (no `$now`, variables or block
  values, and AI fields are left out of `$item`, as a field reading itself or two reading each other never settle).
  The field's value (text, number or Markdown; the output type is fixed once saved) is stored with the item
  (`value_text` / `value_number`) next to a fingerprint of the *rendered* prompt it came from (`value_json`),
  so it syncs and every device agrees. It is stale when today's rendered prompt differs: dependencies need no
  tracking (a prompt reading `$item.Artist` but not `$item.Title` renders the same when only the title changes),
  and `$now`-like input is excluded because it would make everything stale at once. A "layer" around the prompt
  tells the model the collection, the field and the value's shape, and makes the reply fit (`parseAiReply`: a number
  is read out, text goes on one line, a fence around Markdown is dropped; a reply that doesn't fit is an error, never
  stored; when it can't tell, text and Markdown are told to answer "Unknown" (that is the value), a number to stay empty).
  Stale values are found in two places and offered to `AiService` (`app/ai.ts`): by what shows items
  (`useAiFill` in `useCollectionData` and the item page; these go first, and a prompt that can't be made shows its
  reason in place of the value) and by the **backfill** (`app/aiBackfill.ts`, run by `AiBackfillRunner`: every item
  of every collection with an AI field, in every space, shown or not, a few seconds after the app opens and when the
  collections, components, spaces or model change, and at a collection when its items change, but not for a value the
  app generated itself): so a field added to a collection that already has items fills in by itself and can be sorted
  on. Requests are rate limited: 3 at once and one starting every 1.5 s (40 a minute), a 429 answer pauses everything
  30 s and retries the value. More than 10 values waiting at any time (a new field on a big collection, a changed
  prompt, opening the app on a pile of them) stops everything until a modal asks "Generate N AI values?" ("Not now"
  drops them for the session); a pause switch in Settings → AI sends no request at all. Results are stored via
  `Repository.setGenerated` (which leaves the item's `updatedAt` alone). Without a model everything waits; failures
  show their reason in place and "Retry" in the banner (`ui/AiBanner.tsx`, along the bottom of the window); items have
  a "Generate again" button in the label row whose popover shows when the value was generated (or edited) and takes
  a nudge for that value, sent once and not kept. AI fields are skipped by duplicate and the new-item form.
  **Values can be typed over** (item page, table cells for text and numbers; `editableField` edits an AI field as its
  output type): an edited value is stored with `edited` in `value_json` and an empty fingerprint, which the next look at
  the item (`aiStaleness` "adopt", `Repository.acceptEdit`) replaces with the prompt as it reads then. It is never
  made again by itself: when that prompt changes ("ask"), `AiService.offerOverrides` collects the values and a modal
  asks "Replace what you typed?" ("Generate again" replaces them; "Keep mine", also on closing, keeps them as right for
  the item as it is now). "Generate again" and the nudge replace a typed value without that question (the user asked).
  `app/aiScan.ts` sorts values into generate / adopt / ask for both the views and the backfill.
  Prompts are worked out by one code path for the views and the backfill (`domain/refOptions.ts` decides how a
  referenced item is labelled, `aiScan.ts` what a value needs; a missing reference reads as nothing everywhere), so they
  always reach the same fingerprint for the same data. Known trade-offs: two devices that find a stale item at once both ask the
  model (the last write wins, they agree after sync); a changed prompt costs one call per item; a model's answer can
  differ each time, so "regenerate" can change a value.
- **Settings** (`#/settings`, `pages/SettingsPage.tsx`, the last node of the side nav, pinned at its bottom with Help: `NavFooter`): tabs
  Sync (`ui/SyncSettings.tsx`; `?section=sync`) and AI (`ui/AiSettings.tsx`; `?section=ai`): the language model of this
  device: the address of an OpenAI-style API (any provider: OpenAI, OpenRouter, Ollama, LM Studio, …; nothing is preset), the key and two models, each a combo box over the provider's `/models` (any name can be typed): one for AI fields (runs for every value: fast and cheap) and one for writing components (a stronger one; empty = the field model). `AiService.client("field" | "code")` picks it. Stored per device
  (`kubus.ai` in localStorage), never synced. The sync status icon (tab strip, top right) only shows the state; its
  popover tells more and has "Configure sync".
- **Help** (`#/help`, `pages/HelpPage.tsx`, above Settings in the side nav): components and `{{ }}` code, shown exactly like
  an item page (a title and one Markdown field with its name hidden; it reuses `ViewField`). Its text is
  `app/src/help/components.md`, which **must be kept current** when components, `$` names or AI fields change: it is
  also what "Write with AI" gives the model.
- **Write with AI** (component editor, `ui/WriteWithAi.tsx`, `domain/componentWriter.ts`): a few words in, the model writes
  the component's code, description and output (and the name when empty) from the Help text and the fields of the
  preview's collection (else all collections); it only changes the form (not saving drops it) and its box empties, as the next request changes what was just written.
- **Blocks** (`app/src/domain/views.ts` `ViewBlock`, `app/src/views/BlockView.tsx`): a collection
  view is a filter plus a list of blocks; each block shows items one way (table, cards, a
  component) with its own sort and grouping, fields (`FieldLayout`) and
  type options. Its filter is the view's unless it has its own, which replaces it (not stacked;
  "Same as the view's filter" in its Filter menu; its own starts as a copy). Every block, also a
  view's only one, has a header: collapse chevron, name (its title, else its component's name or
  "Table" / "Cards"; set under Block settings; clicking it collapses too) and its menus. In a
  collection view the header can be hidden (tag icon in View settings' block list,
  `ViewBlock.hideHeader`, stored right away): the block then can't collapse and its menus float
  over its top right corner on hover (always shown on touch screens). What
  arranges a view is stored right away, applied to the shown and the saved view alike, so it never
  marks the view changed: adding, removing (asks first) and reordering blocks, a block's type
  ("Show as"), its type options (incl. the component and its variables), name and, on item
  pages, its collection; collapsed blocks and groups (`Collapsed`, in the view's config / the item
  view; groups per grouped-by field). What changes which items show, and how, waits for Save
  changes: filters, sort, grouping and fields (`onChange` vs `onSet` in `BlockView`; `arrange` in
  the pages). The toolbar holds only the view's
  search, filter and settings (at the right of its tab bar). View settings lists the blocks (reorder, remove, "Add block" = a
  copy of the last; a view keeps one). Item pages hold blocks too, among the
  fields (`ItemLayout.blocks`, their ids in `fields`): a block there may list another collection
  (`ViewBlock.collectionId`) and filter on the page's item (rule values `$item` = this item,
  `$item.<fieldId>` = what one of its reference fields points to; `resolvePageValues`), so
  "Books by this Author" is a table on the Author's pages; a new item added there gets the
  filter's references (`filterPreset`). On item pages the same split holds; where blocks sit
  among the fields is field order, saved with Save changes like the fields.
- **Field order and layouts** (`app/src/domain/fieldLayout.ts`, `ui/FieldOrderEditor.tsx`): one
  approach for which fields show in which order: a block's fields (table columns, card fields)
  and item pages (`orderFields`; null = all in the collection's order). Item pages show an item view
  (`collections.item_views`, JSON: name + layout = editable, field names shown, fields and blocks + order):
  the one the item is pinned to (`items.item_view_id`), else the starred one, else the first.
  Once a collection has item views its item pages show them as tabs with "+", delete, pin (this
  item always opens with it) and star (default for all items). The layout popover edits the
  shown view's layout as unsaved changes, saved like a collection page's views (Discard / Save
  changes beside the tabs; "+" after the tabs makes a new view of what is shown). A collection always has at least one item view:
  without stored ones it is a virtual "Default" (`withDefaultItemView`, id `default`), stored once
  changed; the last view can't be deleted. Both tab bars (collection page, item pages) are always
  shown, also for a single view (hiding them was confusing and hid the bookmark button); a changed
  view's tab shows " *"; bookmarking or starring the virtual "All" view stores it first. When a layout hides
  fields or isn't editable, an edit icon switches to the standard page (all fields, editable)
  for the time being.
- **Spaces** (`app/src/domain/spaces.ts`, table `spaces`, `#/spaces`): separate environments (e.g.
  Work / Private) in one database. Every item belongs to one space (`items.space_id`) and shows only
  there; collections (fields, item views) and components are shared. A collection can be
  limited to some spaces (`collections.space_ids`, JSON; null = all; picked in the collection editor).
  Collection views (`views.space_id`; starred per space; a new collection's "All" view goes into
  the space it was made in, other spaces show a virtual "All" view until one is stored), bookmarks
  (`bookmarks.space_id`) and the open tabs (`kubus.workspace.<spaceId>`) are per space;
  the shown space is per device (`kubus.space`), switched from a dropdown atop the side nav. The default space (id `default`, "Space") has no row until renamed,
  like the virtual default item view, and can't be deleted; deleting another deletes its items, views and
  bookmarks. Repository methods that list items take the space explicitly (`listItems`,
  `createItem`, `search`, `countItemsByCollection`, views, bookmarks); `getItem` and `listLabels` read every
  space (a reference may point into another space: labelled, but pickers offer only the shown
  space's items, `RefOption.elsewhere`). An item moves on its page's (i) panel (`moveItem`).
- **Bookmarks** (`app/src/domain/bookmarks.ts`, table `bookmarks`): a bookmark icon on a view (tab strip,
  next to the star) and on an item (page header, next to (i)) toggles a link in the side nav's
  Bookmarks branch (of the shown space). A view bookmark opens `…/items?view=<id>`. Labels are snapshots, refreshed
  while the bookmarked page is shown; bookmarks of deleted views / items aren't listed.
- **Links open any scheme** (https, mailto, tel, spotify:, obsidian:, … open the app registered
  for it) except blocked ones (javascript:, data:, file:, …): `isOpenableUrl` / `safeUrl` in
  `platform/openExternal.ts`, used by Markdown (react-markdown's `urlTransform`), cells and the
  editor; the Tauri opener scope (`desktop/capabilities/default.json`) denies the same schemes.
- **Links to pages of the app** (`domain/links.ts`, `app/useLinks.ts`): plain GFM links without a scheme, written
  by name: `books` (collection, default view), `books/reading-list#table` (view, block), `book/dune#author`
  (item by the singular name; field or block), `book/dune/compact#author` (under an item view); `views/` /
  `items/` after the collection name force the kind. Names match as slugs (lower case, hyphens; a repeat gets
  `-1`). Stored by id (`#/collections/<id>/items?view=&block=`, `…/items/<id>?view=&field=|block=`), so renames
  break nothing: the link dialog converts on Apply, and the editor's popover and dialog show the name form
  again. A name link typed or pasted into the Markdown editor is converted as soon as it names a page (each
  href tried once per editor); one that names nothing stays as written and is resolved when clicked. `?block=` /
  `?field=` scroll to the target and flash it (`ui/useLinkTarget.ts`; blocks carry `data-block-id`, item page
  fields are found by their place among the page's entries).
- **Global search** (`/search?q=`, a bar over the tab strip opened by the search icon, `ui/SearchBar.tsx`): the shown space's items, substring match over string, markdown, HTML and
  list-of-strings values (ASCII case-insensitive; an FTS index can come later).
- **Local first.** The app works fully offline on the device's own SQLite database.
- **Future:** a block's own unnamed component code ("Save as component"), chart block types,
  blocks side by side (a grid), embedding one item's field elsewhere (deliberately left out for now).
- **Sync.** The local SQLite is an offline-first replica of a Postgres-backed server (see "Sync with Postgres").
- **One codebase, many shells.** Desktop runs in Tauri; iOS (and anything else) runs the same web
  build as a home-screen web app (PWA). No native-only features in the core app.
- **Responsive UI** built strictly with the Carbon Design System (`@carbon/react`): use Carbon
  components for every control (DatePicker/TimePicker, NumberInput, ComboBox, …), never native
  inputs or hand-rolled widgets.
- **Pre-alpha, but data is kept where possible.** No migration scripts: when `app/src/data/schema.sql`
  changes, simple changes (new tables, indexes, nullable or defaulted columns; removed plain
  columns; changed CHECKs, e.g. a new field kind: the table is rebuilt with its rows) are applied
  in place and the data is kept; anything else (retyped columns, new NOT NULL columns without
  default) still wipes the local database; tables schema.sql no longer has are dropped. Prefer such
  simple schema changes. For big breaking changes the user starts from a fresh database (no
  compatibility code; the 2026-10 rename to collections / items / components was done that way).
