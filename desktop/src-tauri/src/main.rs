// nod's desktop app: a window onto the UI server (ui/, which a login agent keeps up apart from
// the app), a menu bar icon, and global shortcuts that call the window or capture a todo from any
// app. The UI's pages call nothing here: shortcuts, menus and windows are handled on this side,
// and pages change by the app setting the main window's address.

use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// Where ui/package.json's `start` and `dev` serve the UI.
const SERVER: &str = "127.0.0.1:4800";

// The login agent desktop/launchd/ui.sh installs for the UI server, under the home folder, and
// the variables of its environment that `nod in` takes too.
const AGENT: &str = "Library/LaunchAgents/io.github.kkokworks.nod.ui.plist";
const AGENT_ENV: [&str; 3] = ["PATH", "NOD_HOME", "CLAUDE_CONFIG_DIR"];

// Whether the capture window was opened while another app had the keyboard, to hand it back.
static CAPTURE_FROM_ELSEWHERE: AtomicBool = AtomicBool::new(false);

// The 이동 menu, ⌘1 to ⌘6, in the UI sidebar's order.
const PAGES: [(&str, &str); 6] = [
    ("/focus", "Focus"),
    ("/inbox", "Inbox"),
    ("/projects", "Projects"),
    ("/someday", "Someday/Maybe"),
    ("/waiting", "Waiting For"),
    ("/done", "Done"),
];

// The global shortcuts: their name in shortcuts.json, their default keys, and what they do. A
// global shortcut takes its keys from every app, so the defaults are ⌃⌥⌘ chords, which neither
// macOS (⌥⌘Space, ⌃⌘Space, ⌃Space, ⌃⌥Space) nor Orca (⌘, ⌘⇧, ⌘⌥, ⌘⌥⇧, ⌃) uses.
const SHORTCUTS: [(&str, &str, fn(&AppHandle)); 2] = [
    ("window", "Ctrl+Alt+Cmd+O", toggle_main),
    ("capture", "Ctrl+Alt+Cmd+N", open_capture),
];

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .menu(app_menu)
        .on_menu_event(on_menu)
        .on_window_event(|window, event| {
            // Closing only hides: the app stays in the menu bar, and the window keeps its page.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                put_away(window.app_handle(), window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![capture, dismiss, retry])
        .setup(|app| {
            let handle = app.handle().clone();
            let dev_url = handle.config().build.dev_url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(page(&handle, "/")))
                .title("nod")
                .inner_size(1200.0, 800.0)
                .on_navigation(move |url| {
                    // Links out of the UI (a pull request, a doc) open in the browser instead.
                    let shown = in_window(url, dev_url.as_ref());
                    if !shown {
                        open_in_browser(url);
                    }
                    shown
                })
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            let (taken, problems) = register_shortcuts(&handle);
            let tray = handle.tray_by_id("main").expect("tauri.conf.json defines the tray icon");
            tray.set_menu(Some(tray_menu(&handle, &taken, &problems)?))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // The Dock icon brings the window back.
            if let RunEvent::Reopen { has_visible_windows: false, .. } = event {
                show_main(app);
            }
        });
}

// Captures the text with `nod in`, the one way the ledger changes, and puts the window away. It
// runs in the UI server's environment, so it writes to the ledger the server shows. On failure
// the window keeps the text and shows what went wrong.
#[tauri::command]
async fn capture(app: AppHandle, text: String) -> Result<(), String> {
    let env = agent_env(&app)?;
    let mut nod = Command::new("nod");
    nod.args(["in", "--", text.trim()]).env("NOD_ACTOR", "human:desktop").stdin(Stdio::null());
    for name in AGENT_ENV {
        match env.get(name).and_then(Value::as_str) {
            Some(value) => nod.env(name, value),
            None => nod.env_remove(name),
        };
    }
    let out = nod.output().map_err(|e| format!("nod 를 실행하지 못했습니다: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("nod in 이 실패했습니다({}): {}", out.status, stderr.trim()));
    }
    put_away(&app, "capture");
    Ok(())
}

#[tauri::command]
fn dismiss(app: AppHandle) {
    put_away(&app, "capture");
}

// The offline page asks this on its button and every few seconds, and goes back to the UI once
// the server is up.
#[tauri::command]
async fn retry(window: WebviewWindow, path: String) -> Result<(), String> {
    if !server_up() {
        return Err(format!("{SERVER} 에 아직 화면 서버가 없습니다"));
    }
    window.navigate(server_page(&path)).map_err(|e| e.to_string())
}

// The UI server's environment, as the login agent gives it. An app opened from the Finder has
// launchd's bare PATH and no NOD_HOME, while the agent has those of the shell that installed it.
// Read on each capture, so installing the agent again needs no restart.
fn agent_env(app: &AppHandle) -> Result<Map<String, Value>, String> {
    let plist = app.path().home_dir().map_err(|e| e.to_string())?.join(AGENT);
    if !plist.exists() {
        return Err(format!(
            "화면 서버의 로그인 에이전트({})가 없습니다. nod 레포에서 `sh desktop/launchd/ui.sh install` 을 먼저 실행하세요",
            plist.display()
        ));
    }
    let out = Command::new("/usr/bin/plutil")
        .args(["-extract", "EnvironmentVariables", "json", "-o", "-"])
        .arg(&plist)
        .output()
        .map_err(|e| format!("plutil 을 실행하지 못했습니다: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{} 의 환경을 읽지 못했습니다: {}", plist.display(), stderr.trim()));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("{} 의 환경을 읽지 못했습니다: {e}", plist.display()))
}

fn server_up() -> bool {
    TcpStream::connect_timeout(&SERVER.parse().unwrap(), Duration::from_millis(300)).is_ok()
}

// Only ever a path on the server, so whoever names it cannot send the window elsewhere.
fn server_page(path: &str) -> Url {
    let path = if path.starts_with('/') && !path.starts_with("//") { path } else { "/" };
    format!("http://{SERVER}{path}").parse().unwrap()
}

// The UI server's page at path, or while the server is down, the app's own page that says so and
// goes there once it is up.
fn page(app: &AppHandle, path: &str) -> Url {
    if server_up() {
        return server_page(path);
    }
    // The app's own pages: on the CLI's dev server under `tauri dev`, else on tauri://.
    let base = app.config().build.dev_url.clone();
    let base = base.unwrap_or_else(|| "tauri://localhost/".parse().unwrap());
    let mut url = base.join("offline.html").unwrap();
    url.query_pairs_mut().append_pair("path", path);
    url
}

// Whether the main window goes to url itself: the UI server's pages and the app's own, on tauri://
// or, under `tauri dev`, at dev_url. Any other web address opens in the browser, another server
// on this computer too.
fn in_window(url: &Url, dev_url: Option<&Url>) -> bool {
    !matches!(url.scheme(), "http" | "https")
        || url.origin() == server_page("/").origin()
        || dev_url.is_some_and(|dev| url.origin() == dev.origin())
}

fn open_in_browser(url: &Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let url = url.to_string();
    // On a thread that waits for `open`, so the window does not wait and no zombie is left.
    std::thread::spawn(move || Command::new("/usr/bin/open").arg(url).status());
}

fn bring(window: &WebviewWindow) {
    let _ = window.app_handle().show();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

// Hides the window, and the app as well, which hands the keyboard back to the app the person came
// from: once none of its windows is showing, or when the capture window was opened from another
// app, though the main window stays open behind it.
fn put_away(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
    let from_elsewhere = label == "capture" && CAPTURE_FROM_ELSEWHERE.swap(false, Ordering::Relaxed);
    if from_elsewhere || !app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false)) {
        let _ = app.hide();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        bring(&window);
    }
}

// Calls the window up, or puts it away when it is already in front.
fn toggle_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => {
            put_away(app, "main")
        }
        Some(w) => bring(&w),
        None => {}
    }
}

fn open_capture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("capture") {
        // Asked again while it is open, it keeps where it was first opened from.
        if !window.is_visible().unwrap_or(false) {
            let ours = app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
            CAPTURE_FROM_ELSEWHERE.store(!ours, Ordering::Relaxed);
        }
        bring(&window);
    }
}

fn go(app: &AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(page(app, path));
        bring(&window);
    }
}

// Loads the main window's page again: after the server was rebuilt, or once it went away under
// the page, when this shows the offline page instead.
fn reload(app: &AppHandle) {
    let Some(url) = app.get_webview_window("main").and_then(|w| w.url().ok()) else {
        return;
    };
    let path = if url.path().ends_with("/offline.html") {
        // The offline page stands for the page in its query.
        let path = url.query_pairs().find(|(key, _)| key == "path").map(|(_, value)| value);
        path.map_or_else(|| "/".to_string(), |value| value.into_owned())
    } else {
        format!("{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default())
    };
    go(app, &path);
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().0.as_str() {
        "open" => show_main(app),
        "capture" => open_capture(app),
        "close" => {
            let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
            if let Some(window) = focused {
                put_away(app, window.label());
            }
        }
        "reload" => reload(app),
        "quit" => app.exit(0),
        path if path.starts_with('/') => go(app, path),
        _ => {}
    }
}

// The menu bar. 편집 is there for the pages' text fields: a webview copies and pastes only through
// the menu's items. ⌘W is the app's own item, since a borderless window cannot perform a close.
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let pages = PAGES
        .iter()
        .enumerate()
        .map(|(i, (path, title))| {
            MenuItem::with_id(app, *path, *title, true, Some(format!("CmdOrCtrl+{}", i + 1)))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let pages: Vec<&dyn IsMenuItem<Wry>> = pages.iter().map(|p| p as &dyn IsMenuItem<Wry>).collect();
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "nod",
                true,
                &[
                    &PredefinedMenuItem::hide(app, Some("nod 가리기"))?,
                    &PredefinedMenuItem::hide_others(app, Some("기타 가리기"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some("nod 종료"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "파일",
                true,
                &[
                    &MenuItem::with_id(app, "capture", "받아 적기…", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(app, "close", "창 닫기", true, Some("CmdOrCtrl+W"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "편집",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("실행 취소"))?,
                    &PredefinedMenuItem::redo(app, Some("실행 복귀"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some("오려두기"))?,
                    &PredefinedMenuItem::copy(app, Some("복사하기"))?,
                    &PredefinedMenuItem::paste(app, Some("붙여넣기"))?,
                    &PredefinedMenuItem::select_all(app, Some("모두 선택"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "보기",
                true,
                &[&MenuItem::with_id(app, "reload", "다시 읽기", true, Some("CmdOrCtrl+R"))?],
            )?,
            &Submenu::with_items(app, "이동", true, &pages)?,
        ],
    )
}

// Registers the global shortcuts, with the keys <app config dir>/shortcuts.json gives, if any.
// Returns the keys of each one that took, by name, and what went wrong.
fn register_shortcuts(app: &AppHandle) -> (Vec<(&'static str, String)>, Vec<String>) {
    let mut problems = Vec::new();
    let config = match app.path().app_config_dir().map(|dir| dir.join("shortcuts.json")) {
        Ok(path) if path.exists() => std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<Map<String, Value>>(&text).map_err(|e| e.to_string()))
            .unwrap_or_else(|e| {
                problems.push(format!("{} 을 읽지 못해 기본 키를 씁니다: {e}", path.display()));
                Map::new()
            }),
        _ => Map::new(),
    };
    let mut taken = Vec::new();
    for (name, default, action) in SHORTCUTS {
        let keys = match config.get(name) {
            None => default.to_string(),
            Some(Value::String(keys)) => keys.clone(),
            Some(other) => {
                problems.push(format!(
                    "shortcuts.json 의 {name} 은 \"{default}\" 같은 글자여야 해서 기본 키를 씁니다: {other}"
                ));
                default.to_string()
            }
        };
        let registered = keys.parse::<Shortcut>().map_err(|e| e.to_string()).and_then(|shortcut| {
            app.global_shortcut()
                .on_shortcut(shortcut, move |app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        action(app);
                    }
                })
                .map_err(|e| e.to_string())
        });
        match registered {
            Ok(()) => taken.push((name, keys)),
            Err(e) => problems.push(format!("단축키 {keys} 를 등록하지 못했습니다: {e}")),
        }
    }
    (taken, problems)
}

// The menu bar icon's menu: the global shortcuts that took next to what they do, and what went
// wrong with the others.
fn tray_menu(
    app: &AppHandle,
    taken: &[(&str, String)],
    problems: &[String],
) -> tauri::Result<Menu<Wry>> {
    let keys = |name| taken.iter().find(|(n, _)| *n == name).map(|(_, k)| k.as_str());
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "nod 열기", true, keys("window"))?,
            &MenuItem::with_id(app, "capture", "받아 적기…", true, keys("capture"))?,
            &PredefinedMenuItem::separator(app)?,
        ],
    )?;
    for problem in problems {
        menu.append(&MenuItem::new(app, format!("⚠︎ {problem}"), false, None::<&str>)?)?;
    }
    if !problems.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_ui_server_and_the_apps_pages_stay_in_the_window() {
        let url = |s: &str| s.parse::<Url>().unwrap();
        let dev = url("http://localhost:1430/");
        assert!(in_window(&url("http://127.0.0.1:4800/tasks/1"), None));
        assert!(in_window(&url("tauri://localhost/offline.html?path=%2F"), None));
        assert!(in_window(&url("http://localhost:1430/offline.html?path=%2F"), Some(&dev)));
        assert!(!in_window(&url("http://127.0.0.1:5173/"), None));
        assert!(!in_window(&url("http://localhost:3000/"), Some(&dev)));
        assert!(!in_window(&url("http://localhost:1430/"), None));
        assert!(!in_window(&url("https://example.com/pull/1"), None));
    }
}
