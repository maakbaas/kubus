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
| Checklist | a list of entries, each with text and done |

## What a component shows

Choose the output that fits what your code makes:

- **Markdown** (the default): formatted text.
- **Text**: plain text, shown as it is.
- **Number**: a number, which sorts as a number.
- **Image**: the result is the address of an image.
- **HTML**: a small web page, shown in a sealed-off frame where scripts work. On a page it is as tall as its content; content at 100% height (a map, a chart) fills a box as tall as the block's Height (a Component block's setting, like a chart's or a map's), and content taller than that scrolls inside it.

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
| Block | `$items`, `$groups`, `$fields` or `$all` | a block on a collection view or on an item's page |
| Static | none of these | a block, or the text of a Markdown block: the same everywhere |

A static component can't be a field, as it would be the same for every item. A Markdown block's text may only hold static code: `$now`, but not `$item` or a block's names.

Never use `$item` together with a block's names: such a component fits nowhere.

A block on an item's page doesn't see that page's item as `$item`. Its filter picks the items that belong to it instead, for example "Author is this Author".

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
