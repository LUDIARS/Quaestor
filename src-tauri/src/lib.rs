//! Quaestor — Tauri 2 wrapper.
//!
//! v0.8 では webview のみを Tauri で起動し、 backend (Node) と web (Vite) は
//! 別プロセスでユーザが起動する想定。 sidecar bundle は v0.9 以降で対応。
//!
//! `tauri dev` で起動すると beforeDevCommand が `npm --prefix ../web run dev` を
//! 立ち上げ、 webview が `http://127.0.0.1:5177` を読み込む。 backend (port 17400)
//! は別 shell で `npm run dev` を起動しておく必要がある。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![health])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn health() -> &'static str {
    "ok"
}
