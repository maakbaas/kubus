# Components and `{{ }}` code

A component is text with `{{ … }}` sections. Each section is one JavaScript **expression**; its result replaces it.

```
**{{ $item.Title }}**: about {{ Math.round($item.Pages / 40) }} h of reading
```

- Only one section in the whole text: its value is kept as it is (a number stays a number).
- Expressions only: use `a ? b : c`, `.map(…).join(", ")` and backtick strings. A failing section shows `⚠ message`.

## Values

- `$item`: the item. Fields by name: `$item.Pages` or `$item["Read at"]` (not case sensitive). Also `$item.id`, `createdAt`, `updatedAt`. An empty field is `null`: `{{ $item.Pages ?? 0 }}`.
- `$now`: the current `Date`.
- Blocks only: `$items` (the block's items, each like `$item`), `$groups` (`[{ key, label, items }]`), `$fields` (`[{ id, name, kind }]`), `$all` (every item of the collection).
- Any other `$name` is a **variable**, given a value where the component is used (a field, or a fixed value).

What a field is in code: text, a number, a date as `"2026-10-25"`, a date & time as an ISO text, `true`/`false`, an image as its source (`files/…`, usable in `![](…)`), a reference as the linked item's title (a list of titles for several), a list as an array, a checklist as `[{ text, done }]`.

## Output

Choose what the result is: **Markdown** (default), **Text**, **Number**, **Image** (the result is a URL) or **HTML** (shown in a sandboxed frame; scripts work).

## Where it can go

- Uses `$item`: a field of a collection, or a block on an item's page.
- Uses `$items`, `$groups` or `$fields`: a block that lists items.
- Neither: a static block.

## Examples

```
{{ $item.Pages ? Math.round($item.Pages / 40) : null }}
```

```
{{ $items.map((i) => "- " + i.Title).join("\n") }}
```

## AI fields

An AI field's **prompt** is written the same way and is sent to the model with the sections filled in: `Artist: {{ $item.Artist }}. Give the last name.` Only `$item` exists in it (no `$now`, variables or other AI fields); `{{ $item }}` passes the whole item as JSON. The value is made again only when the prompt, as it reads for that item, changes.
