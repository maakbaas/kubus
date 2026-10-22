# Kubus

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
- **Markdown (GFM) editor**: type your formatting, paste or drop images.
- **Templates.** `{{ … }}` sections of JavaScript compute values, render Markdown or HTML, and are
  reusable across types.
- **Global search** across all your objects.
- **Workspace.** Tabs and tiled panes, side by side, like an editor.
- **Local first.** Everything runs offline on a SQLite database in the app itself.
- **Sync.** Optionally sync every device with your own server backed by Postgres.
- **Everywhere.** A desktop app (Tauri) for Windows, macOS and Linux, and the same build as an
  installable web app on your phone (iOS home-screen app).
- **Compact, themed UI** built with the Carbon Design System; follows your OS light / dark theme.

## Setup

### Desktop app

Download the Windows installer (`.exe` / `.msi`) or the portable `kubus.exe` from the
[Releases page](https://github.com/maakbaas/kubus/releases); each release is built from a version
tag (`v1.2.3`). The portable executable needs no installation (it uses the WebView2 runtime that
Windows 10/11 ships with). Data stays on your device, in the app's own database.

### Build it yourself

You need [Node.js](https://nodejs.org) 22 or newer and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (a Rust toolchain, plus WebView2 on Windows).

```
npm install
npm run dev:web     # the app in a browser at http://localhost:1420
npm run dev         # the desktop app with hot reload
npm run build       # the executable and installers: desktop/target/release
```

`npm run build:web` builds just the web app to `app/dist`.

### Sync server (optional)

Kubus works fully offline. To keep several devices in sync, and to use the app from your phone, run
the server: it syncs through a Postgres database and also serves the web app.

1. Copy `docker-compose.yml` to the machine that will host it.
2. Change `KUBUS_TOKEN` (a long random secret shared by your devices) and the Postgres password
   (in both `POSTGRES_PASSWORD` and `DATABASE_URL`).
3. Run `docker compose up -d`. The server listens on port 8080. Update later with
   `docker compose pull && docker compose up -d`.
4. In the app, open the Sync page (the status icon at the top right), enter the server's address
   and the token, and turn sync on.

To use an existing Postgres instead, remove the `db` service and point `DATABASE_URL` at it. For
the phone (an installable home-screen app) and the desktop app, put the server behind HTTPS, for
example with Caddy, Tailscale Serve or a Cloudflare tunnel.
