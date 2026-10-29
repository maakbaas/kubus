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
  ("New Author"), plural for lists, navigation and counts (`countLabel`). The editor (a collection's or a remote
  collection's) has the plural as its title and the singular below it, which follows the plural until it is
  typed in itself (`suggestSingular`).
- **Items are edited in place**: `#/collections/<id>/items/<itemId>` shows every field in the
  user's order; clicking a field turns it into its form input, with no buttons (they would push the
  content down). Enter saves (Ctrl/Cmd+Enter in markdown), clicking outside saves, Escape cancels;
  checkboxes save on toggle; markdown starts editing where it was clicked. View and edit mode must
  keep the same geometry (label spacing, box height, text position) so nothing jumps. The field
  that is the item's title (`labelField`) isn't repeated among the fields: the page title itself
  is its editor (click to edit in place). Which field is the title is the collection's "Title"
  setting (`collections.title_field`, `titleFields` in `domain/model.ts`): one field, a text, number, date or
  date-time one (`TITLE_KINDS`; a number or date shows as `titleText` gives it, `listLabels` reads it alike, and it
  is edited among the fields, not as the page title: `editedTitleField`), none (`"none"`:
  items are called by the collection's name, tables get no title link), or by default the first text
  field with a value. The full form
  (`…/items/new`) is only for creating. Narrow screens show the items list as cards.
- **List pages' tables on a phone** (Collections, Components, Spaces, Bookmarks; not a view's tables): below
  42rem only the name (still its link; Spaces also its icon) and the row's icon buttons show, one line per row;
  every other column is hidden (`ui/listTable.ts`: `LIST_TABLE` on the table, `LIST_MAIN` on the kept column).
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
  - **Shared or local**: a field either picks a shared component (a row of `components`, by name)
    or has one written in place, a *local* component owned by the field and stored with it: a
    Component / AI field's `fields.code` / `output` / `frame_ratio` (`componentId` null). A
    component block only picks a shared one (its code is written on the component's page, never in
    a popover; "New component" in Block settings or "Add block" names one and opens its page beside);
    a block's own `options.local`, written by earlier versions, still shows and can only be saved as
    shared. A Markdown block's text is local too (static only: `$now`, nothing about items). `fieldComponent` / `blockComponent`
    resolve either. Deleting the place deletes it; nothing else refers to it. The Components page
    lists local ones too (`localComponents`: by where they are used, "Books › Reading time", linked
    to their place; Markdown blocks only when their text has `{{ }}` sections), with "Save as shared
    component" (`PromoteComponentModal`, `ui/promoteLocal.ts`: a shared copy is saved, then the place
    picks it; a Markdown block becomes a component block). The same action sits in the place itself
    (field settings, block settings); "Show" filters the list (all, shared, local). One
    control chooses a field's (`ui/ComponentChoice.tsx`): a dropdown of "Local" plus the shared
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
    / Keep editing, also on × or Escape). A component block's Block settings pick its shared component
    and link to its page.
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
  Server (`ui/ServerConnection.tsx`; `?section=server`, the default: the server's address and token, Save, "Test
  connection" (`SyncControl.testServer`: `/api/health`, then whether the token is accepted; nothing saved) and Disconnect;
  sync, the server's model, remote collections and API tokens all use it), Sync (`ui/SyncSettings.tsx`; `?section=sync`: the
  "Sync this device" switch and "Download images", both applied at once, the state, Wipe local / server database),
  Backup (`ui/BackupSettings.tsx`; `?section=backup`: "Download backup" saves the local database as `kubus-backup-YYYY-MM-DD.sqlite`
  and says what it holds; "Restore from backup…" picks a file, refuses one that is no Kubus database or is a newer app's with the reason,
  asks "Replace all data on this device?", replaces everything, leaves sync off and reloads; docs/sync.md "Backup and restore"),
  Connections (`ui/ConnectionSettings.tsx`; `?section=connections`: the server's remote sources, each set up by its kind's own fields, Host / Port / Database / User for PostgreSQL and so on, as the server describes them; docs/sync.md "Remote sources"; listed as a table like the list pages, name, kind,
  edit and delete icons, each one's problem or warnings above it, and "Add connection": a connection's name or edit icon
  opens its settings in a dialog, `?source=<id>` (`new` for one being added), whose Save stores them on the server at once;
  delete asks first) and AI
  (`ui/AiSettings.tsx`; `?section=ai`) and API tokens (`ui/ApiTokens.tsx`; `?section=tokens`, once connected: the server's
  tokens listed with access, made and last used, revoked after a confirmation, made with a name and Read / Read & write, the
  new token shown once in a dialog with a copy button; docs/sync.md "The API"). Connections and the server's half of AI are the server's own settings, the same
  for every device, stored on the server, keys and passwords write-only (docs/sync.md "The server's settings"; each tab
  saves its part on top of what the server holds then: `ui/useServerSettings.ts`). AI is the language model of this
  device, and its "Language model" dropdown also picks which one the boxes below it set up: "From server" (the default
  for a device without its own; the boxes are the server's address, key and models, saved to the server; asked
  for at `GET /api/ai` and called through the server's proxy `/api/ai/chat/completions` and `/api/ai/models` with the
  sync token, so its key stays on the server: `server/src/ai.ts`, `AiService.providerOf`), or "Local": the address of an OpenAI-style API (any provider: OpenAI, OpenRouter, Ollama, LM Studio, …; nothing is preset), the key and two models, each a combo box over the provider's `/models` (any name can be typed): one for AI fields (runs for every value: fast and cheap) and one for writing components (a stronger one; empty = the field model). `AiService.client("field" | "code")` picks it. Stored per device
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
  view is a filter plus a list of blocks; each block shows items one way (table, cards, a chart, a map, a
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
  table block's Fields popover has the same name toggle per field (hides that column's header label, `hiddenLabels`). A
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
- **Several collections in one block** (merged collections: `domain/blend.ts` `mergeCollections`, `domain/blendMerge.ts`,
  `views/useBlendResult.ts`, `views/MergeFields.tsx`): a block's Collections picker (Block settings, on collection views and item pages)
  takes more than one collection, native and remote mixed (Backlinks can't be merged). The block then reads them as one
  read-only collection made when it is shown (never stored: the block keeps `ViewBlock.collectionIds` and `merges`, JSON in the view's
  config or the item view's layout, no schema or sync change; older devices ignore both and show the first collection). Columns: fields of one
  name (case aside) whose types fit are one column (the matrix, `canShow`: text, Markdown and HTML show each other; a date also a
  date & time, shown as its day in the device's time zone; a date & time only a date & time; number, checkbox and list only their own type),
  a field only one collection has is a column that is empty for the others' rows, fields of one name that can't be shown alike are
  separate columns, the later ones named with their collection ("Total (Shop sales)"); references, images, checklists and component
  fields are left out. Always there: Collection (the part a row is from; never the title unless chosen), Title, Created and Updated
  (rows of a remote collection have neither). Fields → Merge fields merges two differently named fields of different collections that
  fit (Total and Price as Amount; stored with the block, "Unmerge" takes it apart). Column ids are stable (`merged:name:<name>`,
  `merged:<id>`, `merged:collection`), so the block's fields, filters, sort, grouping and chart settings stay. The view's (or page's)
  filter, written over the first collection's fields, is translated to the columns that show them (`translateRules`; its date period too);
  a rule on a field no column shows is left out. How rows come: a native part's items become merged items in memory and the query runs over
  them (`applyQuery`); a remote part is asked by its source with the query rewritten to its columns (`partProjection` + `sourceQuery`:
  no connector changes); a rule on a column a part has no field for (or on Collection) holds for all of that part's rows or none, by whether
  the rule matches an empty value (`ConstantFields`); a sort on such a column is dropped for that part. Paging is a k-way merge
  (`BlendCursor`): each part's page comes in its own order, the merged list takes the next row in the query's sort order, a part is asked for
  its next page only when its rows are used up (Show more across parts); grouped, the groups' sizes and the total are summed over the
  parts, groups are listed in the query's order (by value or summed size) and a group's rows come from every part before the next group's.
  A chart or stat loads every part's rows (a remote part's pages one after the other, with the loading bar and its ×). Text sorts in the app's
  order; a remote part comes in its source's collation, so rows of text sorted by a source that orders differently can be slightly out of
  order in the merged list. Group dates by month, week and the like aren't offered while a part is remote (its source groups by the value).
  Rows are read-only (`isReadOnly`: no edit, add or delete, no "Fields are editable") and open their own item or remote row (`itemPath`;
  the row id is `<collection id>:<item id>`). A collection that is deleted, or a merged column that lost a field, is a warning on the block
  (the rest is shown), never a crash. Component blocks see the merged items as `$items`. Terms: "merged collection" is runtime only; the UI says "Collections".
- **Backlinks** (`domain/backlinks.ts`, `views/useBacklinks.ts`, docs/data-model.md "Item links"): the items that link to an item. A link is a
  reference field's item(s) (Item, List of items) or a link to an item in a Markdown, HTML or AI text
  (`#/collections/<c>/items/<id>`, whatever of its page the link names: a field, view or block counts as the item; the new item
  form doesn't). On an item page a block can list **Backlinks**, offered only in the Collection picker of such blocks (Block settings;
  `VIRTUAL_COLLECTIONS`; it is not in the store's collections, the side nav or any other picker): a virtual collection (`Collection.virtual`,
  read-only like a remote one: `isReadOnly`, so its rows only open) with one row per link from a live native item of the shown space
  that isn't the item itself, also for a remote collection's row. Fields: Item (a Markdown link to the linking item), Title (its label,
  the collection's title), Collection (its plural name: group by it), Field (the name of the field its link is in); Created and Updated
  are the linking item's. Every block type shows it (table, cards, chart, map, a Component block over `$items` / `$groups`) with filter, sort
  and group; a new block starts with Title, Collection, Field and Updated (the title is already the row's link, `BACKLINKS_FIELDS`). A row opens
  the linking item (`itemPath`). Its rows are read when the page shows and again with every item change (`useBacklinkData`,
  `Repository.listBacklinks`). No backlinks to collections, views or blocks. Text in Component and string fields isn't scanned (not stored / not a link).
- **Field order and layouts** (`app/src/domain/fieldLayout.ts`, `ui/FieldOrderEditor.tsx`): one
  approach for which fields show in which order: a block's fields (table columns, card fields)
  and item pages (`orderFields`; null = all in the collection's order). Item pages show an item view
  (`collections.item_views`, JSON: name + layout = editable, field names shown, fields and blocks + order):
  the one the item is pinned to (`items.item_view_id`), else the starred one, else the first.
  Once a collection has item views its item pages show them as tabs with "+", delete, pin (this
  item always opens with it) and star (default for all items). The layout popover edits the
  shown view's layout, stored right away; changes to what its blocks show are unsaved, saved like
  a collection page's views (Discard / Save changes beside the tabs, left of the bar's other buttons and
  never in its "⋮" menu; "+" after the tabs makes a
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
  while the bookmarked page is shown; bookmarks of deleted views / items aren't listed (a remote collection's row has
  no stored item: its bookmark, whose target is the row's id, lasts as long as the collection).
- **Created and Updated** are pickable like fields (`META_FIELDS`, ids `$created` / `$updated`) but hidden by default: a
  layout that never chose its fields (`fields: null`: item pages, table columns, card fields) leaves them out
  (`orderFields`, `itemPageFields` in `domain/fieldLayout.ts`, the field selection's unticked rows); ticking them stores an explicit
  list, which keeps them.
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
  **Link picker** (`ui/LinkPicker.tsx`, `domain/linkTargets.ts`, `app/useLinkTargets.ts`): typing `[text](` (text may
  be empty) or `#/` after a space in the Markdown editor opens a Carbon list at the caret of the shown space's
  collections, views and items (`item#field` lists that item's fields), filtered as typed (ranked: exact, prefix, word
  start, inside, place; a typed or pasted address `#/collections/<id>/items…` finds the page it names). ↑/↓ move, Enter or
  Tab choose, Escape closes it (editor keeps focus), a click chooses; choosing writes an ordinary `[text](#/collections/…)`
  link by id (the text typed, else the option's name). No Markdown syntax is added (`linkTrigger` plugin only reports the
  caret). Labels come from `Repository.listLabels`, per collection, read when first needed.
- **Web addresses in plain values are links** (`Highlight`'s `links`, `splitUrls`): `http(s)://…` in text, list and
  checklist entries, AI and component text (cells, card fields, the item page) opens outside the app (`openExternal`;
  not the item, nor the value's editor). Never in titles (the title is the item's own link, or edited by a click), group
  titles or search results.
- **Tags** (`domain/tags.ts`): `#name` anywhere in text (letters, digits, `_`, `-`, `/` for nested
  `#books/to-read`; at least one letter; not inside a word, `##`, `&#1;` or a URL). Not Markdown syntax: a value stays
  plain GFM and a tag is text in it. Every place that shows text renders it as a Carbon tag (blue, shaped like the collection pills in search; hovering it shows no hover on the link or result it sits in; `ui/TagChip.tsx`):
  plain text through `Highlight` (cells, cards, titles, lists, checklists, AI text, component text, group titles,
  search results), rendered Markdown (`rehypeTags` in `MarkdownView`; not in code or a link's text), the Markdown
  editor (decorations: the text stays as typed), HTML in its frame (the frame's script wraps the tags in the HTML as
  written, not what its scripts draw, and reports clicks). Inline, so view and editor have the same geometry.
  Clicking one opens `/search?q=%23name&tag=1` (Ctrl/Cmd beside, middle click a new tab): exactly that tag and the
  tags nested in it; the same text typed in the search box is a text search (`#books` also finds `#bookshelf`).
- **Global search** (`/search?q=`, a bar over the tab strip opened by the search icon, `ui/SearchBar.tsx`; the icon sits in the right-most pane's strip but doesn't activate that pane, so the results open in the pane that was active when it was clicked): the shown space's collections
  (name, description), the Markdown blocks of its collection views (their text; an item view's is the same on every item, so not
  searched; a result opens the view at the block) and its items, substring match over string, markdown, HTML, AI,
  list-of-strings and checklist values, and the labels of the items an item or list-of-items field points to (ASCII case-insensitive; a full-text index is roadmap #1).
  Each result shows an excerpt of every field that matched (`pages/SearchPage.tsx`); a result with no visible match is left out.
  An item opens at the first field that matched (`?field=`; at the top when its title matched), a Markdown block at the block.
  A text that looks like a link address (`/`, `?`, `=` or `a#b`: `isAddressQuery`) also lists the pages whose link it fits
  (a link list: `LinkTargetList`, the picker's matching), leaving out the collections and items already listed above.
- **Remote collections** (`domain/sources.ts`, `collections.source`, `fields.source_column`; docs/sync.md
  "Remote sources"): a table (for InfluxDB a bucket's measurement) of one of the server's sources, shown like any collection
  but read-only. They have a page of their own, **Remotes** (`#/remotes`, `pages/RemotesPage.tsx`: the
  Collections page's table with a Source column, `CollectionsPage remote`), in the side nav (with the
  space's remote collections below it) as soon as the server has a remote connection, or while remote
  collections exist (`app/useRemotes.ts`, `useRemotesShown`: asked again when the sync settings change or
  the server's settings are saved). They are added ("New remote collection", `#/remotes/new`) and edited
  (`#/remotes/<id>/edit`) there; the Collections page and its side-nav branch show native collections
  only (the editor sends a collection opened under the other path to its own), and a remote collection's
  pages start their breadcrumb with Remotes (`collectionsCrumb`). The collection editor's Source section (`ui/SourceSettings.tsx`)
  picks the source, a table and the key column (the
  primary key by default; assumed unique: a row's item id is its key, base64url); reading the columns
  makes a field per column (named like it, the collection named after the table), "Read columns again"
  keeps the fields' names, order and types and adds or drops the columns that came or went. A column's
  field isn't removed but hidden (the eye icon; `source.hiddenColumns`, "Hidden columns" lists them to show
  again): reading the columns again doesn't bring it back. A text
  column's field can be shown as Markdown or HTML; fields added there are component fields (computed
  for the rows shown); no AI or reference fields, no Created / Updated. Views, blocks, item views,
  bookmarks are as for any collection (stored here, synced); filters, sorts and groupings offer only
  what a column supports (`fieldOperators`, `canSort`, `canGroup`: JSON and the like only "contains" /
  "is empty"); blocks show their Limit of rows (100 unless set; a chart all) and "Show more" (`useRemoteResult`). Nothing edits them: no "New",
  no add row, no in-place editing, no delete or duplicate, checkboxes don't toggle, the item page has
  no editable fields, pin or space; the repository refuses item writes to them too. "Read again" (the
  collection page's views bar) reads the rows again. Needs the server online; nothing is kept offline.
- **Local first.** The app works fully offline on the device's own SQLite database. Every asset is part of the build (IBM Plex included, `app/src/fonts.css`; nothing from a
  CDN) and the service worker caches all of it, so offline it looks exactly as online.
- **Future:** every open item is numbered in `docs/vision.md`, "Open items".
- **Sync.** The local SQLite is an offline-first replica of a Postgres-backed server (see "Sync with Postgres").
- **HTTP API and webhooks.** The server answers `/api/v1` for other tools (with an API token made in Settings → API tokens, read or read & write, or the devices' token), through its own copy of the
  app (the headless device), and can call webhooks on every change (`docs/sync.md`, Help → API).
- **One codebase, many shells.** Desktop runs in Tauri; iOS (and anything else) runs the same web
  build as a home-screen web app (PWA). No native-only features in the core app.
- **Responsive UI** built strictly with the Carbon Design System (`@carbon/react`): use Carbon
  components for every control (DatePicker/TimePicker, NumberInput, ComboBox, …), never native
  inputs or hand-rolled widgets.
- **Schema changes keep the data.** A device's database and the server's are migrated when the app or
  the server is updated; devices and a server of different versions keep syncing, or say which one to
  update (`docs/migrations.md`).
