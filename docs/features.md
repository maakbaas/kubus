# Kubus features

What the app does, feature by feature (read the part you work on).

## Goals

- **User-defined schema.** Users create collections (e.g. Book, Person, Meeting) with arbitrary
  fields, and CRUD both the collections and their items.
- **Field types:** String, Markdown, HTML (source edited in the component code editor, shown in the
  sandboxed `HtmlFrame` like a component's HTML output; its text in tables, cards and search; the
  frame reports clicks on plain content, which start editing, while links, controls, canvas/svg
  and elements with handlers keep their clicks), Number, Date, Date & time, Checkbox, Image, Item (reference
  to an item of another collection, e.g. Book → Author), List of strings, Checklist (items with a
  checkbox, stored as GFM task lines "[x] text", `domain/checklist.ts`; tables show "2/5"),
  List of items, Component (computed from a component, or with Value "AI prompt" written by a language
  model from the component as a prompt: an AI field, kind `ai`).
- **Checkbox and Checklist fields can show an icon instead of the box** (`fields.toggle_icon`, a
  key of `TOGGLE_ICONS` in `ui/ToggleInput.tsx`: heart, star, flag, bookmark, checkmark, thumbs up,
  faces; outlined when off, filled when on; null = Carbon's checkbox). Every place that toggles
  such a value uses `ToggleInput`, never `Checkbox` directly. Markdown task boxes stay GFM boxes.
  A checked one's text is greyed, and struck through with the field's strike through option
  (`fields.strike_through`, synced): a checklist's checked entries; for a checkbox, "Strike through
  the item when checked" also strikes the item where it is listed (`isStruckThrough`: its title in
  table rows, `cell--struck`, and on cards). Component blocks get the checkbox's value in `$items`
  and show it as their code says.
- **Markdown is strictly GitHub Flavored Markdown.** The Milkdown editor (`app/src/ui/MarkdownEditor.tsx`)
  loads only the CommonMark + GFM presets (plus non-syntax utilities: history, clipboard, upload,
  prism, and its own `changes` plugin). Don't add syntax plugins (math, emoji, diagrams, frontmatter, Crepe, …),
  and any future renderer must also be GFM-only. Behaviour-only additions are fine: clickable task
  checkboxes, typed `[text](url)` links, link hover popover (open/edit/remove), code coloring
  (refractor common languages), images via button/paste/drop stored as `files/<sha256>` URLs. A Markdown value is data: `{{ }}` in it is plain text, never run (code lives only in components).
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
- The Milkdown editor reports changes synchronously (`changes` plugin); don't use Milkdown's
  debounced listener plugin: it loses text typed right before saving.
- **Components** (`#/components`, `app/src/domain/components.ts`, table `components`, field kind
  `component`): Markdown with `{{ … }}` sections of JavaScript over the built-ins `$now` / `$item`
  (the item itself, n8n style) and, in a block, `$items` / `$groups` / `$fields` / `$all` (details in
  the header of `components.ts`). There are no variables: fields are read as `$item.Name`, and any
  other `$name` is an error (`unknownNames`, `codeProblem`). **Code lives only in components**: item
  values (string, number, Markdown, HTML) are data, never run. A component that is only `{{ … }}` yields that raw value
  (numbers sort as numbers); otherwise rendered Markdown (rendered on item pages, plain text in
  tables/cards). Results are computed whenever items are shown (`withComputed`, before queries
  run) and never stored; failing sections show `⚠ message`. One concept on purpose: the same
  components are fields and blocks (see Blocks). The code runs in the app with the
  user's rights (`new Function`). The editor previews the result as you type, with only the choices the code calls
  for: a collection when it reads items, an item for `$item`, a field to group by for `$groups`, the
  fields for `$fields` (`CollectionPreview` in `ComponentEditorPage.tsx`).
  - **Shared or local** (one paradigm for every place that takes a component): a place either picks
    a shared component (a row of `components`, by name) or has one written in place, a *local*
    component owned by that place and stored with it: a Component / AI field's `fields.code` /
    `output` / `frame_ratio` (`componentId` null), a component block's `options.local`, a Markdown
    block's text (static only: `$now`, nothing about items). `fieldComponent` / `blockComponent`
    resolve either. Deleting the place deletes it; nothing else refers to it. The Components page
    lists local ones too (`localComponents`: by where they are used, "Books › Reading time", linked
    to their place; Markdown blocks only when their text has `{{ }}` sections), with "Save as shared
    component" (`PromoteComponentModal`, `ui/promoteLocal.ts`: a shared copy is saved, then the place
    picks it; a Markdown block becomes a component block). The same action sits in the place itself
    (field settings, block settings); "Show" filters the list (all, shared, local). One
    control chooses (`ui/ComponentChoice.tsx`): a dropdown of "Local" plus the shared
    components that fit; Local shows the same editor as a shared component's page
    (`ui/ComponentForm.tsx`: Value (Code / AI prompt), Write with AI, Output, the code with its kind and problems, an
    HTML component's shape), the page adding name, description and the preview around it.
    Editing a shared one asks first (it applies everywhere); a local one doesn't.
  - **AI prompt** (the Value switch, `ui/ValueSourceSwitch.tsx`; `components.ai`, a local field component's AI-ness is its field's kind `ai`): the
    component's rendered text is a prompt; the model's reply is an AI field's value, stored (see AI
    fields). Output is then Text, Number or Markdown (`AI_COMPONENT_OUTPUTS`), and an AI component
    only fits a field (`placeProblem`: not a block, no `$now`). An AI field is a Component field with
    "AI prompt" chosen (`fieldKindList` doesn't offer `ai`; the kind is fixed once saved, like an AI field's
    output). A shared component's Value is fixed while fields use it, its output while AI fields
    use it; changing a shared prompt asks first, naming the fields and how many items are asked
    again. The component editor previews a prompt as it reads for an item ("Sent to the model") and
    "Try" asks the model once (nothing stored); Write with AI isn't offered for a prompt (a model writing
    a prompt for a model is a layer too many).
  - HTML output renders in a sandboxed frame that sizes itself, one component for every place
    (`HtmlFrame` in `ui/ComponentValue.tsx`, which documents flow/fill sizing, `frame_ratio`, the
    `<meta name="frame">` override and the zero-specificity base styles).
  - Components see an image field as its src, `files/<sha256>`: Markdown and image outputs (and
    card covers) resolve it to the stored file; HTML frames get each file embedded as a data URL.
  - **Click to edit only what belongs to the place** (field values, Markdown blocks). A component
    field's value is computed, so clicking it does nothing; "Edit component" (code icon in its label
    row, in the "⋮" when its name is hidden) edits its component's code in place
    (`ui/ComponentFieldEditor.tsx`): its own is saved with the field; a shared one asks first, as the
    change applies everywhere the component is used (Change component / Discard changes, which reverts
    / Keep editing, also on × or Escape). A component block's Block settings edit its own component,
    or link to the shared one's page.
  - **Kinds** (`componentUses`, `placeProblem`, `componentsFor`): what a component uses makes it a
    *field* component (`$item`: a component field), a *block* component (`$items` / `$groups` /
    `$fields` / `$all`: a block, which then offers filter, sort, fields as its code needs) or a
    *static* one (neither: a block or a Markdown block's text, `"static"` place; not a field, where
    it would be the same for every item). Never both
    (`mixed`): the component editor refuses to save it. Pickers offer only what fits (component
    fields: field components, AI ones only for AI fields; "Add block" and Block settings: block and
    static); one that doesn't fit where it is used (edited since) shows "⚠ … use it as a block /
    field" there, never an empty result. The Components page has a Kind column ("AI field" for those
    asking AI); the editor says the kind under the code as it is typed. A block on an item page gets
    no `$item`: its filter takes the page's item instead.
  - Fields can also be added from every field picker ("Add field": table columns, card fields,
    item page layout; `ui/FieldModal.tsx`, which also edits component fields). They are ordinary
    fields of the collection, shown in the picker's own view; adding asks for confirmation (the field
    belongs to the collection, not the view). The field dialog and the collection editor show the
    same settings (`ui/FieldSettings.tsx`): name and type in the row, what the type brings (target
    and choice filter, a checkbox's icon and strike through, the component) under it, one control
    per line, set in behind a rule as a part of that field.
- **AI fields** (`app/src/domain/ai.ts`, field kind `ai`: a Component field with Value "AI prompt", its prompt
  its own component in `fields.code` or a shared AI component, its value's form in `fields.output`; model plumbing in
  `app/src/app/ai.ts`, `platform/llm.ts`): a field whose value a language model writes per item. The prompt is a
  component (`{{ $item.Artist }}`); only `$item` exists in it (no `$now` or block
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
  show their reason in place and "Retry" in the AI icon's popover (`AiStatusButton` in `ui/AiBanner.tsx`, left of the
  sync icon and only there while something needs saying: not set up, paused, writing many, failed); items have
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
  Sync (`ui/SyncSettings.tsx`; `?section=sync`), AI (`ui/AiSettings.tsx`; `?section=ai`) and Server
  (`ui/ServerSettings.tsx`; `?section=server`: the sync server's own settings, the same for every device: its language
  model and its remote sources, stored on the server, keys and passwords write-only; docs/sync.md "The server's
  settings"). AI is the language model of this
  device: "The server's" (the default for a device without its own: the one set in Settings → Server, asked
  for at `GET /api/ai` and called through the server's proxy `/api/ai/chat/completions` and `/api/ai/models` with the
  sync token, so its key stays on the server: `server/src/ai.ts`, `AiService.providerOf`), or "My own": the address of an OpenAI-style API (any provider: OpenAI, OpenRouter, Ollama, LM Studio, …; nothing is preset), the key and two models, each a combo box over the provider's `/models` (any name can be typed): one for AI fields (runs for every value: fast and cheap) and one for writing components (a stronger one; empty = the field model). `AiService.client("field" | "code")` picks it. Stored per device
  (`kubus.ai` in localStorage), never synced. The sync status icon (tab strip, top right) only shows the state; its
  popover tells more and has "Configure sync".
- **Help** (`#/help`, `pages/HelpPage.tsx`, above Settings in the side nav): tabs along the top like Settings
  (`?section=components|api`), each shown exactly like an item page (one Markdown field with its name hidden; it
  reuses `ViewField`). Components: components and `{{ }}` code, `app/src/help/components.md`, which **must be kept
  current** when components, `$` names or AI fields change: it is also what "Write with AI" gives the model. API: the
  server's HTTP API and webhooks, `app/src/help/api.md`, kept current with `app/src/headless`.
- **Images have thumbnails** (`ui/thumbnails.ts`): a small copy (shortest side 512 px) made when an image is stored
  (or first shown small), synced like any file. Table cells and cards show it; item pages, Markdown and the
  Lightbox show the full-size image. Settings → Sync → "Download images": all full size after each sync (offline,
  the default), or full size only when opened (thumbnails only until then; for phones with many photos).
- **Write with AI** (component editor, `ui/WriteWithAi.tsx`, `domain/componentWriter.ts`): a few words in, the model writes
  the component's code, description and output (and the name when empty) from the Help text and the fields of the
  preview's collection (else all collections); it only changes the form (not saving drops it) and its box empties, as the next request changes what was just written.
- **Blocks** (`app/src/domain/views.ts` `ViewBlock`, `app/src/views/BlockView.tsx`): a collection
  view is a filter plus a list of blocks; each block shows items one way (table, cards, a chart, a
  component) with its own sort and grouping, fields (`FieldLayout`) and
  type options. It always builds on the view's filter (on an item page, the page's): its own rules,
  in its Filter menu, come after the view's (`ViewQuery.inherited`, `domain/filterTree.ts`), each joined by
  And (narrows it) or Or (an exception to it); its Filter button is blue while it has rules of its own. Every block, also a
  view's only one, has a header (`ui/SectionHeader.tsx`, shared with item fields' label rows): its
  name styled as an item field's label with its block type's icon (its title, else its component's
  name or "Table" / "Cards"; set under Block settings), a collapse caret after it (clicking the name
  collapses too), and its menus at the right; blocks are separated by a line, like item fields. In a
  collection view the header can be hidden (tag icon in View settings' block list,
  `ViewBlock.hideHeader`, stored right away), on an item page with the layout's name toggle (a
  Markdown block too: unnamed, it is headed "Markdown" like any block): the header row goes with
  its menus (no buttons at all), so the content keeps the full width; the block can't collapse. A
  field shown without its name does the same with its label row's buttons ("Generate again"). The line between fields and
  blocks stays either way: a hidden header or name never joins two sections. What
  arranges a view is stored right away, applied to the shown and the saved view alike, so it never
  marks the view changed: adding, removing (asks first) and reordering blocks, a block's type
  ("Show as"), its type options (incl. the component), name and, on item
  pages, its collection; collapsed blocks and groups (`Collapsed`, in the view's config / the item
  view; groups per grouped-by field). What changes which items show, and how, waits for Save
  changes: filters, sort, grouping and fields (`onChange` vs `onSet` in `BlockView`; `arrange` in
  the pages). The toolbar holds only the view's
  search, filter and settings (at the right of its tab bar). View settings lists the blocks (reorder, remove, "Add block" = a
  copy of the last; a view keeps one). Item pages hold blocks too, among the
  fields (`ItemLayout.blocks`, their ids in `fields`): a block there may list another collection
  (`ViewBlock.collectionId`) and filter on the page's item (rule values `$item` = this item,
  `$item.<fieldId>` = one of its values: what a reference field points to, or a value of the same
  kind to compare with, picked by name, "This Book's Year"; `resolvePageValues`), so
  "Books by this Author" is a table on the Author's pages. A block of the page's own collection
  can also be filtered on the item itself: "Item is This Book" (`SELF_FIELD` `$id`, a filter-only
  field, `filterFields`; a remote row by its key), e.g. a gauge of the page's book's pages read; a new item added there gets the
  filter's references (`filterPreset`). On item pages the same split holds: arranging the page
  (its layout: fields and blocks and their order, names shown, editable, hide empty) is stored
  right away too; only what a block shows waits for Save changes.
- **Field order and layouts** (`app/src/domain/fieldLayout.ts`, `ui/FieldOrderEditor.tsx`): one
  approach for which fields show in which order: a block's fields (table columns, card fields)
  and item pages (`orderFields`; null = all in the collection's order). Item pages show an item view
  (`collections.item_views`, JSON: name + layout = editable, field names shown, fields and blocks + order):
  the one the item is pinned to (`items.item_view_id`), else the starred one, else the first.
  Once a collection has item views its item pages show them as tabs with "+", delete, pin (this
  item always opens with it) and star (default for all items). The layout popover edits the
  shown view's layout, stored right away; changes to what its blocks show are unsaved, saved like
  a collection page's views (Discard / Save changes beside the tabs; "+" after the tabs makes a
  new view of what is shown, unsaved changes included). A collection always has at least one item view:
  without stored ones it is a virtual "Default" (`withDefaultItemView`, id `default`), stored once
  changed; the last view can't be deleted. Both tab bars (collection page, item pages) are always
  shown, also for a single view (the bookmark button lives there); a changed
  view's tab shows " *"; bookmarking or starring the virtual "All" view stores it first. When a layout hides
  fields or isn't editable, an edit icon switches to the standard page (all fields, editable)
  for the time being. Every labelled field collapses like a block: a caret before its label (clicking the name collapses too)
  (`FieldCollapse` context, read by `FieldLabel`, so view and edit mode look alike), stored right
  away with the item view's `Collapsed` (field ids among the block ids). The layout's name toggle
  (tag icon, `hiddenLabels`) also covers blocks there: it hides the block's header (its menus move to a "⋮" beside it).
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
- **Tags** (`domain/tags.ts`): `#name` anywhere in text (letters, digits, `_`, `-`, `/` for nested
  `#books/to-read`; at least one letter; not inside a word, `##`, `&#1;` or a URL). Not Markdown syntax: a value stays
  plain GFM and a tag is text in it. Every place that shows text renders it as a Carbon tag (blue, shaped like the collection pills in search; hovering it shows no hover on the link or result it sits in; `ui/TagChip.tsx`):
  plain text through `Highlight` (cells, cards, titles, lists, checklists, AI text, component text, group titles,
  search results), rendered Markdown (`rehypeTags` in `MarkdownView`; not in code or a link's text), the Markdown
  editor (decorations: the text stays as typed), HTML in its frame (the frame's script wraps the tags in the HTML as
  written, not what its scripts draw, and reports clicks). Inline, so view and editor have the same geometry.
  Clicking one opens `/search?q=%23name&tag=1` (Ctrl/Cmd beside, middle click a new tab): exactly that tag and the
  tags nested in it; the same text typed in the search box is a text search (`#books` also finds `#bookshelf`).
- **Global search** (`/search?q=`, a bar over the tab strip opened by the search icon, `ui/SearchBar.tsx`): the shown space's collections
  (name, description), the Markdown blocks of its collection views (their text; an item view's is the same on every item, so not
  searched; a result opens the view at the block) and its items, substring match over string, markdown, HTML, AI,
  list-of-strings and checklist values, and the labels of the items an item or list-of-items field points to (ASCII case-insensitive; a full-text index is roadmap #1).
  Each result shows an excerpt of every field that matched (`pages/SearchPage.tsx`); a result with no visible match is left out.
  An item opens at the first field that matched (`?field=`; at the top when its title matched), a Markdown block at the block.
- **Remote collections** (`domain/sources.ts`, `collections.source`, `fields.source_column`; docs/sync.md
  "Remote sources"): a table or a query (SQL; Flux for InfluxDB, whose tables are a bucket's measurements) of one of the server's sources, shown like any collection
  but read-only. Made with the database icon beside "New collection" (shown while the server offers a
  source: `#/collections/new?remote=1`): the collection editor's Source section (`ui/SourceSettings.tsx`)
  picks the source, a table (or a written query, when the source allows them) and the key column (the
  primary key by default; assumed unique: a row's item id is its key, base64url); reading the columns
  makes a field per column (named like it, the collection named after the table), "Read columns again"
  keeps the fields' names, order and types and adds or drops the columns that came or went. A text
  column's field can be shown as Markdown or HTML; fields added there are component fields (computed
  for the rows shown); no AI or reference fields, no Created / Updated. Views, blocks, item views,
  bookmarks are as for any collection (stored here, synced); filters, sorts and groupings offer only
  what a column supports (`fieldOperators`, `canSort`, `canGroup`: JSON and the like only "contains" /
  "is empty"); blocks show 100 rows and "Show more" (`useRemoteResult`). Nothing edits them: no "New",
  no add row, no in-place editing, no delete or duplicate, checkboxes don't toggle, the item page has
  no editable fields, pin or space; the repository refuses item writes to them too. "Read again" (the
  collection page's views bar) reads the rows again. Needs the server online; nothing is kept offline.
- **Local first.** The app works fully offline on the device's own SQLite database. Every asset is part of the build (IBM Plex included, `app/src/fonts.css`; nothing from a
  CDN) and the service worker caches all of it, so offline it looks exactly as online.
- **Future:** every open item is numbered in `docs/vision.md`, "Open items".
- **Sync.** The local SQLite is an offline-first replica of a Postgres-backed server (see "Sync with Postgres").
- **HTTP API and webhooks.** The server answers `/api/v1` (same token) for other tools, through its own copy of the
  app (the headless device), and can call webhooks on every change (`docs/sync.md`, Help → API).
- **One codebase, many shells.** Desktop runs in Tauri; iOS (and anything else) runs the same web
  build as a home-screen web app (PWA). No native-only features in the core app.
- **Responsive UI** built strictly with the Carbon Design System (`@carbon/react`): use Carbon
  components for every control (DatePicker/TimePicker, NumberInput, ComboBox, …), never native
  inputs or hand-rolled widgets.
- **Schema changes keep the data.** A device's database and the server's are migrated when the app or
  the server is updated; devices and a server of different versions keep syncing, or say which one to
  update (`docs/migrations.md`).
