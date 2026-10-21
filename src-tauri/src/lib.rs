// Thin native shell: all app logic and storage (SQLite via WASM + OPFS) live in
// the web frontend, so the same build also runs as a plain web / home-screen app.
// The only native capability is opening links in the system browser
// (src/platform/openExternal.ts falls back to window.open on the web).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running pkms");
}
