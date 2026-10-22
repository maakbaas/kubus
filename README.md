# Kubus

*Obsidian, where your notes can embed and link live data.*

Kubus is a personal knowledge manager like Obsidian, but backed by a relational store instead of
Markdown files. You define your own types (Book, Person, Meeting, …) with the fields you want,
and fill them with objects that link to each other.

![Kubus showing a Books type as cards](docs/screenshot.png)

## Highlights

- **Your own schema.** Create types with any fields: text, Markdown, numbers, dates, checkboxes,
  images, links to other objects, lists, checklists and computed template fields.
- **Views.** Show a type as a table or as cards, with filters, sorting and grouping. Save as many
  views per type as you like, star a default, bookmark the ones you use most.
- **Edit in place.** Click any field to edit it, no forms or save buttons.
- **Markdown (GFM) editor** without a toolbar: type your formatting, paste or drop images.
- **Templates.** `{{ … }}` sections of JavaScript compute values, render Markdown or HTML, and are
  reusable across types.
- **Links between objects** (reference fields) and global search.
- **Workspace.** Tabs and tiled panes, side by side, like an editor.
- **Local first.** Everything runs offline on a SQLite database in the app itself.
- **Sync.** Optionally sync every device with your own server backed by Postgres.
- **Everywhere.** A desktop app (Tauri) for Windows, macOS and Linux, and the same build as an
  installable web app on your phone (iOS home-screen app).
- **Compact, themed UI** built with the Carbon Design System; follows your OS light / dark theme.

## Getting started

```
npm install
npm run dev:web     # in the browser at http://localhost:1420
npm run dev         # as the desktop app
```

To sync, run the server (`docker compose up -d`, after changing the passwords in
`docker-compose.yml`), then enter its address and token on the app's Sync page. Put it behind
HTTPS to use it from a phone.

Kubus is pre-alpha: expect rough edges. See [CLAUDE.md](CLAUDE.md) for the architecture and
design decisions.
