# Components

A component is a piece of text that fills itself in. You write it like any Markdown, and wherever you put code between double curly braces, the result of that code takes its place.

```component
**{{ $item.Title }}**: about {{ Math.round($item.Pages / 40) }} hours of reading
```

For a book of 412 pages this shows: **Dune**: about 10 hours of reading.

Code lives only in components. What you type into an item's fields is always plain data and never runs.

## Writing code

Each pair of curly braces holds one JavaScript **expression**: something that gives a value, not a series of statements.

- To choose between two values, use a condition: `a ? b : c`.
- To turn a list into text, map and join it: `.map(…).join(", ")`.
- To mix text and values, use backtick strings: `` `${a} of ${b}` ``.

When a whole component is just one section and nothing else, its value is kept as it is: a number stays a number, so it sorts as one.

When a section fails, it shows a warning (⚠ and the error message) in its place, and the rest still shows.

## What your code can read

Everything the code knows comes from a few built-in names, all starting with a dollar sign.

| Name | What it is | Where |
|---|---|---|
| `$item` | the item being shown | fields |
| `$now` | the current date and time (a JavaScript Date) | anywhere but AI prompts |
| `$items` | the items of the block, each like `$item` | blocks |
| `$groups` | the block's groups: a list of key, label and items | blocks |
| `$fields` | the block's fields: a list of id, name and kind | blocks |
| `$all` | every item of the collection | blocks |

There are no other names: a field is always read through the item, as `$item.Pages`. Any other name with a dollar sign is an error.

### Reading fields

Read a field by its name: `$item.Pages`. A name with spaces goes in brackets and quotes: `$item["Read at"]`. Upper and lower case don't matter.

Every item also has its id, and when it was created and last changed: `$item.id`, `$item.createdAt` and `$item.updatedAt`.

An empty field is null. To show something else instead, add a fallback: `{{ $item.Pages ?? 0 }}`.

### What a field's value looks like

| Field type | In code |
|---|---|
| String, Markdown, HTML | text |
| Number | a number |
| Checkbox | true or false |
| Date | text such as "2026-10-25" |
| Date & time | text in ISO form, such as "2026-10-25T09:30:00.000Z" |
| Image | its source, such as files/… (use it in a Markdown image) |
| Item | the title of the linked item |
| List of items | a list of the linked items' titles |
| List of strings | a list of texts |
| List of numbers | a list of numbers |
| Checklist | a list of entries, each with text and done |

## What a component shows

Choose the output that fits what your code makes:

- **Markdown** (the default): formatted text.
- **Text**: plain text, shown as it is.
- **Number**: a number, which sorts as a number.
- **Image**: the result is the address of an image.
- **HTML**: a small web page, shown in a sealed-off frame where scripts work. On a page it is as tall as its content; content at 100% height (a map, a chart) fills a box as tall as the block's Height (a Component block's setting, like a chart's or a map's), and content taller than that scrolls inside it. In a table cell and among a card's fields it is drawn without its scripts, cut off at the row's height: plain HTML and CSS (`style` attributes, `<style>`, SVG), the app's colours as `var(--cds-…)`. Scripts, forms and frames are left out there, and nothing is loaded from another site: images are stored ones (`files/…`) or written into the address (`data:image/…`). So do the work in `{{ }}` (numbers, conditions, the markup itself) when it should show in tables, for example a bar: `<div style="background: var(--cds-layer-accent-01); height: 0.5rem"><div style="width: {{ $item.Progress }}%; height: 100%; background: var(--cds-support-success)"></div></div>`. As a card's cover and on a page the same HTML runs its scripts.

A tag such as #books or #books/to-read in the result shows as a tag, as it does in any text of the app, and clicking it searches for that tag. This works in every output except code. In HTML it works for tags in the HTML as written, not for text a script adds later.

## Where a component can go

A component is **shared** or **local**:

- A **shared** component has a name and is listed on the Components page. Pick it wherever it fits; a change to it applies everywhere it is used.
- A **local** component is written in one place: a Component field, or the text of a Markdown block. The Components page lists it by where it is used, and "Save as shared component" turns it into a shared one.

A Component block always shows a shared component: pick one in its Block settings, or choose "New component" there (or "New component…" under Add block), give it a name, and write it on its page, which opens beside the view.

What the code reads decides what kind of component it is, and so where it can go:

| Kind | Reads | Can be |
|---|---|---|
| Field | `$item` | a Component field: one value per item |
| Block | `$items`, `$groups`, `$fields` or `$all` | a block on a collection view, on an item's page or on a dashboard |
| Static | none of these | a block, or the text of a Markdown block: the same everywhere |

A static component can't be a field, as it would be the same for every item. A Markdown block's text may only hold static code: `$now`, but not `$item` or a block's names.

Never use `$item` together with a block's names: such a component fits nowhere.

A block on an item's page doesn't see that page's item as `$item`. Its filter picks the items that belong to it instead, for example "Author is this Author".

A block on a dashboard sees its own block's items as `$items` (the rows of all its collections when it lists several), after the dashboard's filter; there is no `$item` on a dashboard.


### Several collections in one block

On a dashboard, a block's Block settings → **Collections** can choose more than one collection, native and remote ones together (a block of a collection view lists its own collection, an item page's block one collection or Backlinks). The block then lists them as one: `$items` holds the rows of all of them. Fields with the same name (and a type that fits) are one field; a field only one has is empty for the others' rows; **Collection** is the name of the collection a row is from, and Created and Updated are there too. Fields → **Merge fields** makes one field of two with different names. These rows can't be changed.

### Backlinks

A block on an item's page can list **Backlinks**: choose it as the block's Collection in Block settings. These are the items that link to the page's item (also a row of a remote collection), one row for each link: a link in a Markdown, HTML or AI text, or a field of type Item or List of items that holds it. A link to a field, view or block of the item counts as one to the item. Backlinks can't be changed. Their fields:

| Field | What it is |
|---|---|
| Item | a Markdown link to the linking item |
| Title | the linking item's title |
| Collection | the collection the linking item is in (plural, such as "Books") |
| Field | the name of the field its link is in |
| Created, Updated | when the linking item was created and last changed |

A table, cards, a chart or a Component block shows them like any items: filter, sort and group them (for example by Collection), and in a component they are `$items`, `$groups` and `$fields`, read through `$item` as usual (`i.Title`, `i.Collection`, `i.Field`, `i.createdAt`, `i.updatedAt`, and `i.Item` for the link).

```component
{{ $items.map((i) => `- ${i.Item} (${i.Collection}, ${i.Field})`).join("\n") }}
```

### A list field's entries

A block can list the entries of a list field (a Checklist, List of strings, List of numbers or List of items) of every item of a collection: choose it as the block's Collection in Block settings, named like "Books / Todo" (on a collection view: its own list fields; on a dashboard: alone). Each entry is a row with these fields:

| Field | What it is |
|---|---|
| the collection's name ("Book") | the item the entry is in (on that item's page a new block shows only its entries) |
| the field's name ("Todo") | the entry: a checklist's text, a string or a number |
| Done | a checklist's: whether it is ticked (tick it right in the block) |
| Position | its place in the list: 1, 2, … |

A List of items' rows are the linked items themselves, with their own fields, plus the item they are in and Position. Group a checklist by Done, chart a list of numbers, filter by the item: like any items. In a component they are `$items` as usual:

```component
{{ $items.filter((i) => !i.Done).map((i) => `- ${i.Todo} (${i.Book})`).join("\n") }}
```

## Examples

Reading time for a book, empty when the page count is missing:

```component
{{ $item.Pages ? Math.round($item.Pages / 40) : null }}
```

A block that lists its items' titles:

```component
{{ $items.map((i) => "- " + i.Title).join("\n") }}
```

## Code in filters

A filter's value can hold code too, typed in curly braces like in a component. It is worked out when the filter runs, as if you had typed its result.

- `{{ 1 == 1 }}` is true, which matches checked items.
- `{{ new Date().toISOString().slice(0, 10) }}` is today's date.

Filter code can read `$now`, and in a block on an item's page also that page's item as `$item`. A value that can't be compared matches nothing.

## Asking AI

Switch **Value** from *Code* to *AI prompt* and a component becomes a **prompt**. You write it the same way. For each item, the sections are filled in and the text is sent to a language model. The model's reply becomes the value of an AI field (a Component field that asks AI) and is stored with the item.

```component
Artist: {{ $item.Artist }}. Give the last name.
```

- Only `$item` exists in a prompt: no `$now`, no block's names, and no other AI fields.
- `{{ $item }}` on its own passes the whole item, as JSON.
- The output is Text, Number or Markdown.
- A value is only asked for again when the prompt, as it reads for that item, changes.
