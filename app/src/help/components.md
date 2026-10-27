# Components and `{{ }}` code

A component is text with `{{ … }}` sections. Each section is one JavaScript **expression**; its result replaces it. Code lives only in components (and AI prompts): the values of items are plain data, never run.

```
**{{ $item.Title }}**: about {{ Math.round($item.Pages / 40) }} h of reading
```

- Only one section in the whole text: its value is kept as it is (a number stays a number).
- Expressions only: use `a ? b : c`, `.map(…).join(", ")` and backtick strings. A failing section shows `⚠ message`.

## Values

- `$item`: the item. Fields by name: `$item.Pages` or `$item["Read at"]` (not case sensitive). Also `$item.id`, `createdAt`, `updatedAt`. An empty field is `null`: `{{ $item.Pages ?? 0 }}`.
- `$now`: the current `Date`.
- A block's: `$items` (the block's items, each like `$item`), `$groups` (`[{ key, label, items }]`), `$fields` (`[{ id, name, kind }]`), `$all` (every item of the collection).
- Any other `$name` is a **variable**, given a value where the component is used (a field, or a fixed value).

What a field is in code: text, a number, a date as `"2026-10-25"`, a date & time as an ISO text, `true`/`false`, an image as its source (`files/…`, usable in `![](…)`), a reference as the linked item's title (a list of titles for several), a list as an array, a checklist as `[{ text, done }]`.

## Output

Choose what the result is: **Markdown** (default), **Text**, **Number**, **Image** (the result is a URL) or **HTML** (shown in a sandboxed frame; scripts work).

## Kinds: where it can go

What a component uses makes it one of three kinds:

- **Field** component, uses `$item`: one item, shown as a Component field of a collection.
- **Block** component, uses `$items`, `$groups`, `$fields` or `$all`: a block's items, on a collection view or an item's page (where the block's filter can pick the items that belong to the page's item).
- **Static** component, uses neither: goes anywhere, as a field (a value from its variables) or a block (the same content everywhere).

Never use `$item` together with a block's names: such a component fits nowhere. A block on an item's page doesn't see the page's item as `$item`; its filter takes it ("Author is this Author").

## Examples

```
{{ $item.Pages ? Math.round($item.Pages / 40) : null }}
```

```
{{ $items.map((i) => "- " + i.Title).join("\n") }}
```

## AI fields

An AI field's **prompt** is written the same way and is sent to the model with the sections filled in: `Artist: {{ $item.Artist }}. Give the last name.` Only `$item` exists in it (no `$now`, variables or other AI fields); `{{ $item }}` passes the whole item as JSON. The value is made again only when the prompt, as it reads for that item, changes.
