# The HTTP API

A Kubus server answers an HTTP API at `/api/v1`, for scripts, automation tools and cron jobs: everything the app can do to your data. It goes through the server's own copy of the app (its *headless device*), so it follows the same rules as the app, and a change made through it is on every device as soon as they sync.

## Authentication

Every request carries the server's token, the same `KUBUS_TOKEN` your devices use:

```
curl -H "Authorization: Bearer $KUBUS_TOKEN" https://notes.example.com/api/v1/collections
```

Whoever has the token can read and change everything, and can run component code on the server. Keep it secret.

## Requests and answers

- JSON in and out (`Content-Type: application/json`), except for file bytes.
- Names: a collection by its id, name or plural name; a space, field, component, view or item view by its id or name. Not case sensitive. Without `space`, the default space.
- Errors are `{ "error": "…" }`: `400` bad input, `404` unknown collection, item, field, …, `405` wrong method, `409` refused by a rule (deleting the only space, a collection others refer to), `413` too large, `415` not an image, `503` the server's device can't sync (or the API isn't built).
- A write answers once the change is on the server.

## Items

An item looks like this:

```json
{
  "id": "…", "collection": "Book", "collectionId": "…", "spaceId": "default", "itemViewId": null,
  "label": "Dune", "createdAt": "2026-10-27T09:00:00.000Z", "updatedAt": "…",
  "values": { "Title": "Dune", "Pages": 412, "Read": false, "Author": "<item id>", "Summary": "…" }
}
```

Values by field name, as stored:

| Field type | Value |
|---|---|
| String, Markdown, HTML | text |
| Number | number |
| Checkbox | `true` / `false` |
| Date | `"2026-10-27"` |
| Date & time | ISO 8601, e.g. `"2026-10-27T09:00:00.000Z"` |
| Image | a file id (see Files) |
| Item | an item id; List of items: a list of ids |
| List of strings | a list of texts |
| Checklist | `["[x] done", "[ ] to do"]`; also taken as `[{ "text": "…", "done": true }]` |
| Component | computed, read only |
| AI | text (or a number); set with the AI route below |

An empty field is `null`. Component values are included, computed as the app shows them; writing one is refused. Component code runs on the server without Node's globals and gets 1 s per section.

| Method and path | What |
|---|---|
| `GET /collections/{c}/items?space=&limit=&offset=` | `{ items, total, limit, offset }`, newest change first; `limit` up to 1000 (default 100) |
| `POST /collections/{c}/items` `{ space?, values }` | create; returns the item (201) |
| `GET /items/{id}` | one item |
| `PATCH /items/{id}` `{ values }` | change only the fields given |
| `DELETE /items/{id}` | delete |
| `POST /items/{id}/move` `{ space }` | move to another space |
| `PUT /items/{id}/item-view` `{ itemView }` | pin an item view (`null`: the collection's default) |
| `PUT /items/{id}/ai/{field}` `{ value }` | an AI field's generated value (for the prompt as it reads now) |
| `POST /items/{id}/ai/{field}/accept` | keep a value typed over an AI field |
| `GET /search?q=&space=&limit=` | search, as the app's search |

```
curl -X POST -H "Authorization: Bearer $KUBUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"values": {"Title": "Dune", "Pages": 412}}' https://notes.example.com/api/v1/collections/books/items
```

## Collections and fields

| Method and path | What |
|---|---|
| `GET /collections?space=` | collections with their fields, item views and item counts |
| `GET /collections/{c}` | one collection |
| `POST /collections` `{ name, pluralName?, icon?, description?, spaces?, space?, fields }` | create (with its "All" view in `space`) |
| `PATCH /collections/{c}` `{ name?, pluralName?, icon?, description?, spaces? }` | change its settings |
| `DELETE /collections/{c}` | delete, with its items |
| `POST /collections/{c}/fields` `{ name, kind, … }` | add a field |
| `PATCH /collections/{c}/fields/{f}` `{ name?, … }` | change a field |
| `DELETE /collections/{c}/fields/{f}` | remove a field (a collection keeps at least one) |
| `PUT /collections/{c}/fields/order` `["Title", "Pages", …]` | field order (the ones not named keep their order, after these) |

A field is `{ name, kind }` plus what its kind needs: `targetCollection` (Item, List of items), for Component and AI fields a shared `component` or their own one (`code`, with `output` and `frameRatio`; an AI field's `code` is its prompt and its `output` `string`, `number` or `markdown`, fixed once saved), and optionally `choiceFilter`, `toggleIcon`, `strikeThrough`. Kinds: `string`, `markdown`, `html`, `number`, `date`, `datetime`, `checkbox`, `image`, `item`, `string_list`, `checklist`, `item_list`, `component`, `ai`. A field's kind and target can't change. `spaces` is a list of spaces, or `null` for every space.

## Views

| Method and path | What |
|---|---|
| `GET /collections/{c}/views?space=` | collection views |
| `POST /collections/{c}/views` `{ name, space?, filters?, blocks?, editable? }` | create |
| `PATCH /collections/{c}/views/{v}?space=` | change |
| `DELETE /collections/{c}/views/{v}?space=` | delete |
| `PUT /collections/{c}/default-view` `{ space?, view }` | the default view (`null`: none) |
| `GET /collections/{c}/item-views` | item views |
| `PUT /collections/{c}/item-views` `[{ name, isDefault?, layout }]` | replace the item views |

A block is `{ kind, title?, filters?, sort?, groupBy?, layout?, collectionId?, options? }`, with `kind` `table`, `cards`, `component` or `markdown`. Fields in it are named by id or name: `filters` `[{ fieldId, operator, value }]`, `sort` `[{ fieldId, direction }]`, `layout.fields`.

## Spaces, bookmarks, components

| Method and path | What |
|---|---|
| `GET /spaces`, `POST /spaces` `{ name, icon? }` | spaces |
| `PATCH /spaces/{s}` `{ name?, icon? }`, `DELETE /spaces/{s}` | rename, delete (with its items) |
| `GET /bookmarks?space=` | bookmarks |
| `POST /bookmarks` `{ kind: "item", target }` or `{ kind: "view", collection, target }`, `space?`, `label?` | add |
| `PATCH /bookmarks/{target}` `{ label }`, `DELETE /bookmarks/{target}?space=` | rename, remove |
| `GET /components`, `GET /components/{x}` | components with their code |
| `POST /components` `{ name, code, output?, ai?, description?, frameRatio? }` | create (`ai`: Ask AI, a prompt for AI fields) |
| `PATCH /components/{x}`, `DELETE /components/{x}?withFields=true` | change, delete (`withFields`: its fields too) |

## Files

Images are stored apart from items and named by the SHA-256 of their bytes:

```
curl -X POST -H "Authorization: Bearer $KUBUS_TOKEN" -H "Content-Type: image/png" \
  --data-binary @cover.png https://notes.example.com/api/v1/files
→ { "id": "<sha256>", "src": "files/<sha256>" }
```

Put the `id` in an image field, or `![](files/<sha256>)` in Markdown. `GET /files/{id}` gives the bytes back. PNG, JPEG, GIF, WebP, AVIF and SVG, up to 20 MB. A file no item uses is deleted a week later (by the apps, the next time one opens or syncs).

## Webhooks

Set `KUBUS_WEBHOOK_URL` on the server (several URLs separated by commas) and it POSTs every change, made on any device or through the API:

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

- One request per batch of changes the server's device receives: changes close together arrive in one request, and an item created and deleted in between is only `item.deleted`.
- `item` is as the API returns it, computed values included.
- With `KUBUS_WEBHOOK_SECRET` set, each request carries `X-Kubus-Signature: sha256=<HMAC-SHA256 of the body with the secret, hex>`: compute it over the raw body and compare.
- In order, one at a time per URL, retried after 1, 5 and 30 seconds, then dropped. Best effort: a restart loses what was waiting.
