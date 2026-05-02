//! Quaestor — Tauri 2 wrapper.
//!
//! 構成:
//! - dev (`tauri dev`): beforeDevCommand が `npm run dev:all` を起動 (concurrently で
//!   backend + web 両方)、 webview は devUrl http://127.0.0.1:5177 を読む
//! - prod (`tauri build`): beforeBuildCommand が `npm run build:all` で TS / Vite を
//!   compile、 lib.rs::setup() で `node ../dist/server.js` を spawn して backend を起動、
//!   起動完了 (HEALTH probe 成功) を待ってから webview を開く
//!
//! 制約 (v0.9): production binary は別途 Node 22+ が PATH 必要。 Node を Tauri に
//! bundle するのは v1.0+ で対応 (pkg / nexe / native rewrite のいずれか).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};

/// 子プロセス (Node backend) ハンドル。 アプリ終了時に kill する。
struct BackendChild(Mutex<Option<Child>>);

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    backend: bool,
    backend_url: String,
}

const BACKEND_URL: &str = "http://127.0.0.1:17400";
const HEALTH_TIMEOUT_SEC: u64 = 15;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BackendChild(Mutex::new(None)))
        .setup(|app| {
            // dev mode は backend を beforeDevCommand 経由で別 process として起動済みなので何もしない。
            // production の release build のみ自前 spawn する。
            if cfg!(not(debug_assertions)) {
                if let Err(e) = spawn_backend(&app.handle()) {
                    eprintln!("[quaestor] failed to spawn backend: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![health])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            kill_backend(app_handle);
        }
    });
}

/// production の Node backend spawn。 同梱されている `dist/server.js` を node で起動する。
/// node が PATH に無い場合はエラーログを出して諦める (webview だけは開く)。
fn spawn_backend(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let server_js = locate_server_js(app)?;
    let mut cmd = Command::new("node");
    cmd.arg(&server_js)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let child = cmd.spawn()?;
    {
        let state = app.state::<BackendChild>();
        let mut guard = state.0.lock().unwrap();
        *guard = Some(child);
    }

    // /health probe で起動を待つ
    let deadline = Instant::now() + Duration::from_secs(HEALTH_TIMEOUT_SEC);
    while Instant::now() < deadline {
        if probe_health() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }
    eprintln!("[quaestor] backend health probe timed out, continuing anyway");
    Ok(())
}

fn locate_server_js(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // 優先順位:
    // 1. resource_dir/backend/server.js (Tauri bundle resource)
    // 2. ../dist/server.js (cargo run from src-tauri/)
    // 3. ../../dist/server.js (release exe at target/release/, project root に dist/)
    let candidates = [
        app.path().resource_dir().ok().map(|p| p.join("backend").join("server.js")),
        std::env::current_dir().ok().map(|p| p.join("..").join("dist").join("server.js")),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|dir| dir.join("dist").join("server.js"))),
    ];
    for c in candidates.iter().flatten() {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err("dist/server.js not found — run `npm run build` first".into())
}

fn probe_health() -> bool {
    let url = format!("{BACKEND_URL}/health");
    matches!(ureq::get(&url).timeout(Duration::from_millis(500)).call(), Ok(r) if r.status() == 200)
}

fn kill_backend(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackendChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[tauri::command]
fn health() -> HealthResponse {
    HealthResponse {
        ok: true,
        backend: probe_health(),
        backend_url: BACKEND_URL.to_string(),
    }
}
