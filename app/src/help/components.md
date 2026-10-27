# Components and `{{ }}` code

A component is text with `{{ … }}` sections. Each section is one JavaScript **expression**; its result replaces it. Code lives only in components: the values of items are plain data, never run.

A component is **shared** (on the Components page, picked by name wherever it fits) or **local**: written in one place only (a Component field, a Component block, a Markdown block's text), listed on the Components page by where it is used, and saved as a shared one with "Save as shared component".

```
**{{ $item.Title }}**: about {{ Math.round($item.Pages / 40) }} h of reading
```

- Only one section in the whole text: its value is kept as it is (a number stays a number).
- Expressions only: use `a ? b : c`, `.map(…).join(", ")` and backtick strings. A failing section shows `⚠ message`.

## Values

- `$item`: the item. Fields by name: `$item.Pages` or `$item["Read at"]` (not case sensitive). Also `$item.id`, `createdAt`, `updatedAt`. An empty field is `null`: `{{ $item.Pages ?? 0 }}`.
- `$now`: the current `Date`.
- A block's: `$items` (the block's items, each like `$item`), `$groups` (`[{ key, label, items }]`), `$fields` (`[{ id, name, kind }]`), `$all` (every item of the collection).
- There are no other `$` names: read a field as `$item.Name`. Any other `$name` is an error.

What a field is in code: text, a number, a date as `"2026-10-25"`, a date & time as an ISO text, `true`/`false`, an image as its source (`files/…`, usable in `![](…)`), a reference as the linked item's title (a list of titles for several), a list as an array, a checklist as `[{ text, done }]`.

## Output

Choose what the result is: **Markdown** (default), **Text**, **Number**, **Image** (the result is a URL) or **HTML** (shown in a sandboxed frame; scripts work).

## Filters

A filter's value may hold `{{ }}` code too, typed as it is: it is worked out when the filter runs, as if its result had been typed. `{{ 1 == 1 }}` is `true` (checked items), `{{ new Date().toISOString().slice(0, 10) }}` today's date. It reads `$now`, and in a block on an item page that page's item as `$item`. A value that can't be compared matches nothing.

## Kinds: where it can go

What a component uses makes it one of three kinds:

- **Field** component, uses `$item`: one item, shown as a Component field of a collection.
- **Block** component, uses `$items`, `$groups`, `$fields` or `$all`: a block's items, on a collection view or an item's page (where the block's filter can pick the items that belong to the page's item).
- **Static** component, uses neither: the same content everywhere, as a block or a Markdown block's text (whose `{{ }}` sections may only be static: `$now`, not `$item` or a block's names). Not as a field: it would be the same for every item.

Never use `$item` together with a block's names: such a component fits nowhere. A block on an item's page doesn't see the page's item as `$item`; its filter takes it ("Author is this Author").

## Examples

```
{{ $item.Pages ? Math.round($item.Pages / 40) : null }}
```

```
{{ $items.map((i) => "- " + i.Title).join("\n") }}
```

## Ask AI

A component with **Ask AI** on is a **prompt**: written the same way, it is sent to a language model with the sections filled in for one item, and the model's reply is the value of an AI field (a Component field asking AI), stored for that item: `Artist: {{ $item.Artist }}. Give the last name.` Only `$item` exists in it (no `$now`, no block's names, no other AI fields); `{{ $item }}` passes the whole item as JSON. Its output is Text, Number or Markdown. The value is made again only when the prompt, as it reads for that item, changes.
