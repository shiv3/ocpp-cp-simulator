//! Tauri entry point — boots the simulator daemon as a sidecar so the
//! desktop app delivers the full `--web-console` UX instead of the
//! static Local-mode-only build.
//!
//! Flow on startup:
//!   1. Pick a free TCP port on 127.0.0.1.
//!   2. Spawn `ocpp-cp-sim` (the Bun-compiled sidecar from
//!      `src-tauri/binaries/`) with `--http-port <port> --web-console
//!      --state-db <app-data-dir>/state.db --log-format json`.
//!      In `cargo run` / `tauri dev` builds the sidecar binary may not
//!      exist yet; fall back to `bun src/cli/main.ts` so devs can
//!      iterate without re-running the build script.
//!   3. Splash window (`splash.html`) opens immediately, asks Rust for
//!      the daemon URL via `get_daemon_url`, polls `/v1/healthz`, then
//!      navigates the same webview to `http://127.0.0.1:<port>/`.
//!   4. On window close the child is killed.

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Cached during setup so the `get_daemon_url` Tauri command can return it
/// without re-doing port selection on every invocation.
struct DaemonUrl(String);

/// Child handle is held under a Mutex<Option<…>> so we can take() it out
/// during the close handler without needing interior-mutability tricks.
struct DaemonChild(Mutex<Option<CommandChild>>);

#[tauri::command]
fn get_daemon_url(state: tauri::State<'_, DaemonUrl>) -> String {
    state.0.clone()
}

fn find_free_port() -> Result<u16, std::io::Error> {
    // Bind to port 0, ask the OS for an ephemeral port, then release.
    // There's a small TOCTOU window before the daemon binds, but the
    // window is short and any clash would just surface as a startup
    // failure (which we'd see in the splash error path).
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn state_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create app_data_dir {dir:?}: {e}"))?;
    Ok(dir.join("state.db"))
}

/// Spawn the daemon. Production builds invoke the bundled sidecar via
/// `tauri-plugin-shell`; dev builds (`cargo run`, `tauri dev`) drop back
/// to `bun src/cli/main.ts` so the loop stays tight without having to
/// re-build a 60 MB compiled binary every iteration.
fn spawn_daemon(
    app: &AppHandle,
    port: u16,
    state_db: &str,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let args = [
        "--http-host",
        "127.0.0.1",
        "--http-port",
        &port.to_string(),
        "--web-console",
        "--state-db",
        state_db,
        "--log-format",
        "json",
    ];

    // In debug builds, prefer `bun src/cli/main.ts` so contributors don't
    // need a sidecar binary to iterate. The path is resolved at compile
    // time from CARGO_MANIFEST_DIR (= src-tauri/) so it works no matter
    // what cwd Tauri spawns us with. In release builds, only the sidecar
    // exists.
    #[cfg(debug_assertions)]
    {
        let main_ts: String = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src/cli/main.ts")
            .to_string_lossy()
            .into_owned();
        match app
            .shell()
            .command("bun")
            .args(std::iter::once(main_ts.as_str()).chain(args.iter().copied()))
            .spawn()
        {
            Ok(handle) => return Ok(handle),
            Err(err) => {
                eprintln!(
                    "[tauri] `bun src/cli/main.ts` spawn failed ({err}); falling back to sidecar"
                );
            }
        }
    }

    app.shell()
        .sidecar("ocpp-cp-sim")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 2nd invocation: focus the existing window instead of
            // starting a 2nd daemon (which would clash on state.db).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_daemon_url])
        .setup(|app| {
            let port = find_free_port()
                .map_err(|e| format!("could not find a free TCP port: {e}"))?;
            let daemon_url = format!("http://127.0.0.1:{port}");
            app.manage(DaemonUrl(daemon_url.clone()));

            let state_db = state_db_path(&app.handle())?;
            let state_db_str = state_db
                .to_str()
                .ok_or_else(|| format!("state.db path is not valid UTF-8: {state_db:?}"))?
                .to_owned();

            let (mut rx, child) = spawn_daemon(&app.handle(), port, &state_db_str)?;
            app.manage(DaemonChild(Mutex::new(Some(child))));

            // Drain the daemon's stdout/stderr into the app log so a
            // crash isn't silent. The daemon already speaks JSON-line
            // logs (we passed `--log-format json`), so this is plenty
            // grep-friendly.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            eprintln!("[daemon] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[daemon] exited: {:?}", payload);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Daemon owns the only writer to state.db, so killing it
                // before the window closes avoids a lock the next launch
                // would have to wait on. `kill` translates to SIGTERM on
                // Unix / TerminateProcess on Windows; the daemon's SIGTERM
                // handler triggers `lifecycle.requestShutdown` for a clean
                // exit.
                if let Some(state) = window.app_handle().try_state::<DaemonChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
