# The HTTP API

Your Kubus server can be reached by scripts, automation tools and scheduled jobs. Through it they can do everything the app can do with your data: read and change items, set up collections and views, add images, and more.

The API goes through the server's own copy of the app (its *headless device*). So it follows the same rules as the app, and a change made through it reaches every device the next time it syncs.

All addresses below start with /api/v1 on your server.

## Getting started

Every request needs the server's token: the same KUBUS_TOKEN your devices use to sync. Send it as a bearer token. This lists your collections:

```bash
curl -H "Authorization: Bearer $KUBUS_TOKEN" https://notes.example.com/api/v1/collections
```

And this adds a book:

```bash
curl -X POST -H "Authorization: Bearer $KUBUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"values": {"Title": "Dune", "Pages": 412}}' \
  https://notes.example.com/api/v1/collections/books/items
```

> Whoever has the token can read and change everything, and can run component code on the server. Keep it secret.

## How requests work

- **JSON in, JSON out.** Send bodies as JSON (with the Content-Type header application/json). Only file uploads send raw bytes.
- **Use names or ids.** A collection can be named by its id, its name or its plural name ("books" above). Spaces, fields, components, views and item views go by id or name. Upper and lower case don't matter.
- **Spaces.** Without a space given, the default space is used.
- **Writes are confirmed.** A write answers once the change is stored on the server.

When something goes wrong, the answer is an error message as JSON, `{ "error": "…" }`, with one of these status codes:

| Status | Meaning |
|---|---|
| 400 | the request isn't right (a missing or wrong value) |
| 404 | no such collection, item, field, … |
| 405 | that method isn't allowed here |
| 409 | refused by a rule, such as deleting the only space or a collection others refer to |
| 413 | too large |
| 415 | not an image |
| 503 | the server's device can't sync (or the API wasn't built) |

## Items

An item comes back like this:

```json
{
  "id": "…", "collection": "Book", "collectionId": "…", "spaceId": "default", "itemViewId": null,
  "label": "Dune", "createdAt": "2026-10-27T09:00:00.000Z", "updatedAt": "…",
  "values": { "Title": "Dune", "Pages": 412, "Read": false, "Author": "<item id>", "Summary": "…" }
}
```

Its values are listed by field name. An empty field is null.

| Field type | Value |
|---|---|
| String, Markdown, HTML | text |
| Number | a number |
| Checkbox | true or false |
| Date | text such as "2026-10-27" |
| Date & time | text in ISO 8601 form, such as "2026-10-27T09:00:00.000Z" |
| Image | a file id (see Files) |
| Item | the id of the linked item |
| List of items | a list of ids |
| List of strings | a list of texts |
| Checklist | a list such as ["[x] done", "[ ] to do"]; entries with text and done are taken too |
| Component | worked out as the app shows it; can't be written |
| AI | text or a number; written with its own address (below) |

Component values run on the server, without Node's globals, and each section gets one second.

| Method and address | What it does |
|---|---|
| `GET /collections/{c}/items` | list items, most recently changed first: `{ items, total, limit, offset }`. Optional: space, limit (up to 1000, default 100), offset |
| `POST /collections/{c}/items` | create an item from `{ space?, values }`; answers with the new item (201) |
| `GET /items/{id}` | one item |
| `PATCH /items/{id}` | change only the fields given in `{ values }` |
| `DELETE /items/{id}` | delete |
| `POST /items/{id}/move` | move to another space: `{ space }` |
| `PUT /items/{id}/item-view` | pin an item view: `{ itemView }` (null for the collection's default) |
| `PUT /items/{id}/ai/{field}` | set an AI field's generated value: `{ value }` (for the prompt as it reads now) |
| `POST /items/{id}/ai/{field}/accept` | keep a value someone typed over an AI field |
| `GET /search` | search, as the app does. Takes q, and optionally space and limit |

## Collections and fields

| Method and address | What it does |
|---|---|
| `GET /collections` | all collections, with their fields, item views and item counts (optional: space) |
| `GET /collections/{c}` | one collection |
| `POST /collections` | create one from `{ name, pluralName?, icon?, description?, spaces?, space?, fields }`, with its "All" view in that space |
| `PATCH /collections/{c}` | change its settings: `{ name?, pluralName?, icon?, description?, spaces?, titleField? }` (`titleField`: the text field its items are called by, by id or name; `"none"` for no title; null for the first text field with a value) |
| `DELETE /collections/{c}` | delete it, with its items |
| `POST /collections/{c}/fields` | add a field: `{ name, kind, … }` |
| `PATCH /collections/{c}/fields/{f}` | change a field |
| `DELETE /collections/{c}/fields/{f}` | remove a field (a collection keeps at least one) |
| `PUT /collections/{c}/fields/order` | set the field order from a list of names; fields left out keep their order, after these |

A remote collection (read from a database of the server, made in the app) is listed too, but its rows aren't items here: it has none in the API, and adding or changing items in it is refused.

For spaces, give a list of spaces, or null for every space.

### Describing a field

A field needs a **name** and a **kind**. The kinds are string, markdown, html, number, date, datetime, checkbox, image, item, string_list, checklist, item_list, component and ai. A field's kind and target can't change later.

Some kinds need more:

- **Item** and **List of items**: targetCollection, the collection they point to.
- **Component**: either a shared component (component), or its own code (code, with output and frameRatio).
- **AI**: the same, where its code is the prompt and its output is string, number or markdown. The output is fixed once saved.

Any field can also have a choiceFilter, a toggleIcon and strikeThrough.

## Views

| Method and address | What it does |
|---|---|
| `GET /collections/{c}/views` | the collection views (optional: space) |
| `POST /collections/{c}/views` | create one from `{ name, space?, filters?, blocks?, editable? }` |
| `PATCH /collections/{c}/views/{v}` | change one (optional: space) |
| `DELETE /collections/{c}/views/{v}` | delete one (optional: space) |
| `PUT /collections/{c}/default-view` | set the default view: `{ space?, view }` (null for none) |
| `GET /collections/{c}/item-views` | the item views |
| `PUT /collections/{c}/item-views` | replace the item views with a list of `{ name, isDefault?, layout }` |

A block is `{ kind, title?, filters?, sort?, groupBy?, layout?, collectionId?, options? }`. Its kind is table, cards, component or markdown. Fields in a block can be named by id or by name, in:

- filters, a list of `{ fieldId, operator, value, join? }`. `join` is `and` (the default) or `or`: how the rule joins the rules before it, read in order (`A or B and C` is `(A or B) and C`). A block always builds on its view's filter (on an item page, on the item view's `layout.filters`, whose fields can be of any of its blocks' collections, applied while it has more than one block listing items): its rules come after the view's, so `and` narrows the view's filter and `or` makes an exception to it. A date period frames its own filter: it is and-ed with that filter's other rules, wherever it is in the list (a date period: operator `between`, value `2026-10-01..2026-10-31`, both days included, or counted from today: `day`, `week`, `month` or `year` and an offset, `week+0` this week, `month-1` last month);
- sort, a list of `{ fieldId, direction }`;
- layout.fields.

## Spaces, bookmarks and components

| Method and address | What it does |
|---|---|
| `GET /spaces` | the spaces |
| `POST /spaces` | create one: `{ name, icon? }` |
| `PATCH /spaces/{s}` | rename: `{ name?, icon? }` |
| `DELETE /spaces/{s}` | delete, with its items |
| `GET /bookmarks` | the bookmarks (optional: space) |
| `POST /bookmarks` | add one: `{ kind: "item", target }` or `{ kind: "view", collection, target }`, with optional space and label |
| `PATCH /bookmarks/{target}` | rename: `{ label }` |
| `DELETE /bookmarks/{target}` | remove (optional: space) |
| `GET /components`, `GET /components/{x}` | components, with their code |
| `POST /components` | create one: `{ name, code, output?, ai?, description?, frameRatio? }`; with ai on it is a prompt for AI fields |
| `PATCH /components/{x}` | change one |
| `DELETE /components/{x}` | delete one; add ?withFields=true to delete the fields that use it too |

## Files

Images are stored apart from items, named by a fingerprint of their bytes (SHA-256). Upload one by sending its bytes:

```bash
curl -X POST -H "Authorization: Bearer $KUBUS_TOKEN" -H "Content-Type: image/png" \
  --data-binary @cover.png https://notes.example.com/api/v1/files
→ { "id": "<sha256>", "src": "files/<sha256>" }
```

Then put the id in an image field, or use the src in Markdown: `![](files/<sha256>)`. GET /files/{id} gives the bytes back.

- Allowed: PNG, JPEG, GIF, WebP, AVIF and SVG, up to 20 MB.
- A file that no item uses is deleted a week later (by the apps, the next time one opens or syncs).

## Webhooks

The server can tell other services about every change, whether it was made on a device or through the API. Set KUBUS_WEBHOOK_URL on the server to one address, or several separated by commas, and it sends them a POST like this:

```json
{ "database": "…", "cursor": 123, "events": [
  { "type": "item.created", "id": "…", "collection": "Book", "collectionId": "…", "spaceId": "default", "item": { … } },
  { "type": "item.updated", … },
  { "type": "item.deleted", "id": "…", "collection": "Book", "collectionId": "…", "spaceId": "…" },
  { "type": "collection.changed", "id": "…" },
  { "type": "view.changed", "id": "…", "collectionId": "…" },
  { "type": "space.changed", "id": "…" }, { "type": "component.changed", "id": "…" }, { "type": "bookmark.changed", "id": "…" }
] }
```

- **Batched.** One request for each batch of changes the server's device receives, so changes close together arrive together. An item created and deleted in between only shows up as item.deleted.
- **Whole items.** An event's item is as the API returns it, worked-out values included.
- **Signed.** With KUBUS_WEBHOOK_SECRET set, each request has an X-Kubus-Signature header: sha256= followed by the HMAC-SHA256 of the body with the secret, in hex. Work it out over the raw body and compare.
- **Delivery.** In order, one at a time per address. A failed request is retried after 1, 5 and 30 seconds, then dropped. This is best effort: a server restart loses what was still waiting.
