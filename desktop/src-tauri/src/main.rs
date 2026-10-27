// nod's desktop app: a window onto the UI server (ui/, which a login agent keeps up apart from
// the app), a menu bar icon, and global shortcuts that call the window or capture a todo from any
// app. The UI's pages call nothing here: shortcuts, menus and windows are handled on this side,
// and pages change by the app setting the main window's address.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use objc2::runtime::{AnyObject, Bool, ClassBuilder, Sel};
use objc2::{class, msg_send, sel};
use serde_json::{Map, Value};
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalPosition, Manager, RunEvent, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// Where ui/package.json's `start` and `dev` serve the UI.
const SERVER: &str = "127.0.0.1:4800";

// The login agent desktop/launchd/ui.sh installs for the UI server, under the home folder, and
// the variables of its environment that `nod in` takes too.
const AGENT: &str = "Library/LaunchAgents/io.github.kkokworks.nod.ui.plist";
const AGENT_ENV: [&str; 3] = ["PATH", "NOD_HOME", "CLAUDE_CONFIG_DIR"];

// Whether make_panel made the capture window a panel. If not, showing it activates the app.
static PANEL: AtomicBool = AtomicBool::new(false);

// Whether `nod in` is running. The capture window then stays up when it loses focus, so that a
// failure shows.
static CAPTURING: AtomicBool = AtomicBool::new(false);

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
        .on_window_event(|window, event| match event {
            // Closing only hides: the app stays in the menu bar, and the window keeps its page.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                put_away(window.app_handle(), window.label());
            }
            // Like Spotlight, the capture window goes away once the person turns elsewhere.
            WindowEvent::Focused(false)
                if window.label() == "capture" && !CAPTURING.load(Ordering::Relaxed) =>
            {
                put_away(window.app_handle(), "capture")
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![capture, dismiss, retry])
        .setup(|app| {
            let handle = app.handle().clone();
            let dev_url = handle.config().build.dev_url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(page(&handle, "/")))
                .title("nod")
                .inner_size(1200.0, 800.0)
                .on_navigation(move |url| {
                    // Links out of the UI (a pull request, a doc, mailto:) open outside instead.
                    let shown = in_window(url, dev_url.as_ref());
                    if !shown {
                        open_outside(url);
                    }
                    shown
                })
                .on_new_window(|url, _| {
                    open_outside(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            if let Some(capture) = handle.get_webview_window("capture") {
                make_panel(&capture);
            }
            watch_server(handle.clone());
            let (taken, problems) = register_shortcuts(&handle);
            let tray = handle.tray_by_id("main").expect("tauri.conf.json defines the tray icon");
            tray.set_menu(Some(tray_menu(&handle, &taken, &problems)?))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // The Dock icon brings the main window back, also while the capture window is up.
            if let RunEvent::Reopen { .. } = event {
                let main = app.get_webview_window("main");
                if !main.is_some_and(|w| w.is_visible().unwrap_or(false)) {
                    show_main(app);
                }
            }
        });
}

// Captures the text with `nod in`, the one way the ledger changes, and puts the window away. It
// runs in the UI server's environment, so it writes to the ledger the server shows. On failure
// the window keeps the text and shows what went wrong.
#[tauri::command]
async fn capture(app: AppHandle, text: String) -> Result<(), String> {
    CAPTURING.store(true, Ordering::Relaxed);
    let result = nod_in(&app, &text);
    CAPTURING.store(false, Ordering::Relaxed);
    result?;
    put_away(&app, "capture");
    Ok(())
}

fn nod_in(app: &AppHandle, text: &str) -> Result<(), String> {
    let env = agent_env(app)?;
    let mut nod = Command::new("nod");
    nod.args(["in", "--", text.trim()]).env("NOD_ACTOR", "human:desktop").stdin(Stdio::null());
    for name in AGENT_ENV {
        match env.get(name).and_then(Value::as_str) {
            Some(value) => nod.env(name, value),
            None => nod.env_remove(name),
        };
    }
    let out = nod.output().map_err(|e| match e.kind() {
        ErrorKind::NotFound => "에이전트의 PATH 에 nod 가 없습니다. `bun link` 를 한 셸에서 `sh desktop/launchd/ui.sh install` 을 다시 돌리세요".to_string(),
        _ => format!("nod 를 실행하지 못했습니다: {e}"),
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("nod in 이 실패했습니다({}): {}", out.status, failure(&stderr)));
    }
    Ok(())
}

// What went wrong, from a failed command's stderr. bun puts an uncaught error's message (`error:
// …`, `TypeError: …`) under the source lines around the throw and above the stack, which would
// push it out of the capture window's few lines, so only the message is kept.
fn failure(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().collect();
    // After the ^ under the throw, if bun showed the source.
    let start = lines.iter().position(|l| l.trim_start().starts_with('^')).map_or(0, |i| i + 1);
    let message: Vec<&str> = lines[start..]
        .iter()
        .take_while(|l| !(l.starts_with(' ') && l.trim_start().starts_with("at ")))
        .copied()
        .collect();
    message.join("\n").trim().to_string()
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

// The UI server's path a main window url shows, or for the offline page, the one it stands for.
fn shown_path(url: &Url) -> String {
    if url.path().ends_with("/offline.html") {
        let path = url.query_pairs().find(|(key, _)| key == "path").map(|(_, value)| value);
        return path.map_or_else(|| "/".to_string(), |value| value.into_owned());
    }
    format!("{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default())
}

// The server can also go down under a page already shown (a reinstall, a crash), so every few
// seconds the main window goes to the offline page if so. That page comes back once it is up.
fn watch_server(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let Some(window) = app.get_webview_window("main") else { continue };
        let Ok(url) = window.url() else { continue };
        if url.origin() == server_page("/").origin() && !server_up() {
            let _ = window.navigate(page(&app, &shown_path(&url)));
        }
    });
}

// Whether the main window goes to url itself: the UI server's pages, the app's own (on tauri://
// or, under `tauri dev`, at dev_url) and what a page makes in place (about:blank, blob:, data:).
// Anything else opens outside: a web address in the browser, another server on this computer
// too, and mailto: and the like in the app macOS has for them.
fn in_window(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {
            url.origin() == server_page("/").origin()
                || dev_url.is_some_and(|dev| url.origin() == dev.origin())
        }
        "tauri" | "about" | "blob" | "data" => true,
        _ => false,
    }
}

fn open_outside(url: &Url) {
    // `open` runs what a file: link names, so a page's link to a program would start it.
    if url.scheme() == "file" {
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

// Hides the window. Once none of the app's windows is showing, it hides the app as well, which
// hands the keyboard back to the app the person came from if nod was active. The capture panel
// does not make nod active (make_panel), but a click on it may, as can the plain window it stays
// when make_panel fails.
fn put_away(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
    if !app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false)) {
        let _ = app.hide();
    }
}

// Makes the capture window a panel that takes the keyboard without activating the app, as
// Spotlight's does: it comes up alone over the app in front, not with nod's other windows, and
// once it goes away that app has the keyboard again. tauri makes only windows, so this swaps the
// class of the one tao made (an NSWindow subclass) for an NSPanel subclass, as tauri-nspanel does.
fn make_panel(window: &WebviewWindow) {
    extern "C" fn yes(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }
    let Ok(ns_window) = window.ns_window() else { return };
    let ns_window = ns_window.cast::<AnyObject>();
    let Some(mut panel) = ClassBuilder::new(c"NodCapturePanel", class!(NSPanel)) else { return };
    // A borderless window takes the keyboard only if its class says so.
    unsafe { panel.add_method(sel!(canBecomeKeyWindow), yes as extern "C" fn(_, _) -> _) };
    let panel = panel.register();
    unsafe {
        // The object stays the size tao allocated, so the new class must not need more.
        if panel.instance_size() > (*ns_window).class().instance_size() {
            return;
        }
        objc2::ffi::object_setClass(ns_window, panel);
        let mask: usize = msg_send![ns_window, styleMask];
        // NSWindowStyleMaskNonactivatingPanel
        let () = msg_send![ns_window, setStyleMask: mask | 1 << 7];
        let () = msg_send![ns_window, setHidesOnDeactivate: false];
    }
    PANEL.store(true, Ordering::Relaxed);
}

// Centers the window on the screen the pointer is on, which is where the person is looking.
fn center_on_pointer(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    // tao gives the pointer in the primary screen's pixels but finds screens by points (macOS's
    // logical units), and gives each screen in its own pixels: all in points here.
    let primary = app.primary_monitor()?.map_or(1.0, |m| m.scale_factor());
    let pointer = app.cursor_position()?.to_logical::<f64>(primary);
    let Some(screen) = app.monitor_from_point(pointer.x, pointer.y)? else { return Ok(()) };
    let at = screen.position().to_logical::<f64>(screen.scale_factor());
    let room = screen.size().to_logical::<f64>(screen.scale_factor());
    let size = window.outer_size()?.to_logical::<f64>(window.scale_factor()?);
    window.set_position(LogicalPosition::new(
        at.x + (room.width - size.width) / 2.0,
        at.y + (room.height - size.height) / 2.0,
    ))
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

// Brings up the capture panel without activating the app, so nod's other windows stay where they
// are. Each time it comes up it is on the screen the pointer is on and without the last error;
// what was typed stays.
fn open_capture(app: &AppHandle) {
    let Some(window) = app.get_webview_window("capture") else { return };
    if !window.is_visible().unwrap_or(false) {
        let _ = center_on_pointer(&window);
        let _ = window.eval("document.getElementById('error').textContent = ''");
    }
    // A hidden app shows none of its windows. put_away hides it only with none of them up, so
    // unhiding brings back nothing else, unless the person hid nod (⌘H) with its window open.
    let _ = app.run_on_main_thread(|| unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let hidden: bool = msg_send![ns_app, isHidden];
        if hidden {
            let () = msg_send![ns_app, unhideWithoutActivation];
        }
    });
    let _ = window.show();
    // A plain window takes the keyboard only with its app active.
    if !PANEL.load(Ordering::Relaxed) {
        let _ = window.set_focus();
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
    go(app, &shown_path(&url));
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
        assert!(in_window(&url("about:blank"), None));
        assert!(!in_window(&url("mailto:someone@example.com"), None));
        assert!(!in_window(&url("file:///Applications/Calculator.app"), None));
    }

    #[test]
    fn a_failure_shows_buns_error_message_without_the_source_and_stack() {
        let thrown = "126 |   if (title === '') throw new Error(TODO_USAGE)\n                          ^\nerror: usage: nod in <title>\n  --key <id>\n      at capture (/x/src/todo-cli.ts:130:27)\n\nBun v1.3.14 (macOS arm64)\n";
        assert_eq!(failure(thrown), "error: usage: nod in <title>\n  --key <id>");
        let type_error = "1 | null.x\n    ^\nTypeError: null is not an object\n      at /x/[eval]:1:1\n";
        assert_eq!(failure(type_error), "TypeError: null is not an object");
        assert_eq!(failure("env: bun: No such file or directory\n"), "env: bun: No such file or directory");
    }

    #[test]
    fn the_offline_page_stands_for_the_path_in_its_query() {
        let url = |s: &str| s.parse::<Url>().unwrap();
        assert_eq!(shown_path(&url("http://127.0.0.1:4800/tasks/1?tab=log")), "/tasks/1?tab=log");
        assert_eq!(shown_path(&url("tauri://localhost/offline.html?path=%2Ftasks%2F1")), "/tasks/1");
        assert_eq!(shown_path(&url("tauri://localhost/offline.html")), "/");
    }

    #[test]
    fn a_panel_fits_in_the_window_tao_makes() {
        // make_panel swaps tao's NSWindow subclass, which adds an ivar, for an NSPanel one.
        let size = |name: &std::ffi::CStr| {
            objc2::runtime::AnyClass::get(name).unwrap().instance_size()
        };
        assert!(size(c"NSPanel") <= size(c"NSWindow"));
    }
}
