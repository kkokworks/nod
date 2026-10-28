// A worker's terminal in a window of the app: tmux attached to the worker's session in a PTY, drawn
// by the app's own page (terminal.html, with xterm.js). The page gets what the PTY prints through a
// channel and sends what is typed and its size; only the app's terminal windows may
// (capabilities/terminal.json), never the UI server's pages. Closing the window ends the PTY, which
// detaches tmux: the worker goes on, and while the window is open `nod gc` sees a person attached.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::{mpsc, LazyLock, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// A terminal window's label, before its task's number.
const LABEL: &str = "terminal-";

const NOT_OPEN: &str = "이 창의 터미널이 열려 있지 않습니다";

// The PTY of each terminal window, by its label.
static PTYS: LazyLock<Mutex<HashMap<String, Pty>>> = LazyLock::new(Default::default);

struct Pty {
    master: Box<dyn MasterPty + Send>,
    // Dropped, it types a newline and ^D into the PTY (portable-pty), which tmux would pass on to
    // the worker as keys: Pty's drop ends tmux first.
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

// Hangs up on tmux, which detaches, and waits for it to go. Runs before the fields drop.
impl Drop for Pty {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// The task whose terminal a main window address asks for: the UI server's /terminal/<task>, which
// a browser shows as the worker's screen instead (ui/src/routes/terminal.$id.tsx).
pub fn task_at(url: &Url) -> Option<u32> {
    if url.origin() != crate::server_page("/").origin() {
        return None;
    }
    url.path().strip_prefix("/terminal/")?.parse().ok()
}

// The task of a terminal window, by its label; None for the app's other windows.
pub fn task_of(label: &str) -> Option<u32> {
    label.strip_prefix(LABEL)?.parse().ok()
}

// Opens the task's terminal window, or brings it up when it is open already.
pub fn open(app: &AppHandle, task: u32) {
    let label = format!("{LABEL}{task}");
    if let Some(window) = app.get_webview_window(&label) {
        crate::bring(&window);
        return;
    }
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App("terminal.html".into()))
        .title(format!("#{task} 터미널"))
        .inner_size(960.0, 640.0)
        .build();
}

// Ends the PTY of a window that closed, if it had one.
pub fn closed(label: &str) {
    let pty = PTYS.lock().unwrap().remove(label);
    drop(pty);
}

// Runs tmux attached to the window's task in a new PTY of the page's size, in place of the one the
// window had (its page loaded again). What it prints goes to `output` as it comes, then an empty
// message once it ends: tmux detached, or the session ended. The command is nod's (nod attach
// --print), run in the UI server's environment as nod is, where the workers' tmux server is.
#[tauri::command]
pub async fn pty_open(
    window: WebviewWindow,
    cols: u16,
    rows: u16,
    output: Channel,
) -> Result<(), String> {
    let task = task_of(window.label()).ok_or(NOT_OPEN)?;
    let app = window.app_handle().clone();
    let printed = crate::nod(&app, &["attach", "--print", &task.to_string()])?;
    let mut tmux = CommandBuilder::new("/bin/sh");
    // exec: tmux itself holds the PTY, so the hangup reaches it.
    tmux.args(["-c", &format!("exec {}", printed.trim())]);
    for (name, value) in crate::agent_vars(&app)? {
        match value {
            Some(value) => tmux.env(name, value),
            None => tmux.env_remove(name),
        }
    }
    // Unset as nod attach does. xterm.js speaks UTF-8, which tmux otherwise takes from the locale.
    tmux.env_remove("TMUX");
    tmux.env("TERM", "xterm-256color");
    tmux.env("LC_CTYPE", "UTF-8");

    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    // Both before tmux starts, so that failing leaves no tmux attached.
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(tmux).map_err(|e| e.to_string())?;
    // tmux keeps the other end alone, so reading ends once it does.
    drop(pair.slave);
    let pty = Pty { master: pair.master, writer, child };
    std::thread::spawn(move || {
        let mut buf = [0; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = output.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = output.send(InvokeResponseBody::Raw(Vec::new()));
    });

    // Kept on the main thread, where the window's Destroyed comes (closed), so a window that closed
    // meanwhile does not keep it, and the commands below find it once this returns.
    let label = window.label().to_string();
    let (kept, wait) = mpsc::channel();
    let main = app.clone();
    main.run_on_main_thread(move || {
        if app.get_webview_window(&label).is_some() {
            let replaced = PTYS.lock().unwrap().insert(label, pty);
            drop(replaced);
        }
        let _ = kept.send(());
    })
    .map_err(|e| e.to_string())?;
    let _ = wait.recv();
    Ok(())
}

// What is typed in the window's terminal.
#[tauri::command]
pub fn pty_write(window: WebviewWindow, data: String) -> Result<(), String> {
    let mut ptys = PTYS.lock().unwrap();
    let pty = ptys.get_mut(window.label()).ok_or(NOT_OPEN)?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

// The window's new size, which tmux redraws the worker's screen to.
#[tauri::command]
pub fn pty_resize(window: WebviewWindow, cols: u16, rows: u16) -> Result<(), String> {
    let ptys = PTYS.lock().unwrap();
    let pty = ptys.get(window.label()).ok_or(NOT_OPEN)?;
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    pty.master.resize(size).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn the_main_window_opens_a_terminal_for_the_ui_servers_terminal_address() {
        let url = |s: &str| s.parse::<Url>().unwrap();
        assert_eq!(task_at(&url("http://127.0.0.1:4800/terminal/12")), Some(12));
        assert_eq!(task_at(&url("http://127.0.0.1:4800/terminal/12?from=task")), Some(12));
        assert_eq!(task_at(&url("http://127.0.0.1:4800/tasks/12")), None);
        assert_eq!(task_at(&url("http://127.0.0.1:4800/terminal/abc")), None);
        assert_eq!(task_at(&url("http://127.0.0.1:4800/terminal/12/x")), None);
        assert_eq!(task_at(&url("http://127.0.0.1:5173/terminal/12")), None);
        assert_eq!(task_at(&url("https://example.com/terminal/12")), None);
        assert_eq!(task_at(&url("tauri://localhost/terminal/12")), None);
    }

    #[test]
    fn a_terminal_window_is_known_by_its_label() {
        assert_eq!(task_of("terminal-12"), Some(12));
        assert_eq!(task_of("terminal-"), None);
        assert_eq!(task_of("main"), None);
        assert_eq!(task_of("capture"), None);
    }

    #[test]
    fn only_the_apps_own_terminal_windows_may_run_a_pty() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities");
        let mut terminal = false;
        for file in std::fs::read_dir(dir).unwrap() {
            let text = std::fs::read_to_string(file.unwrap().path()).unwrap();
            let capability: Value = serde_json::from_str(&text).unwrap();
            // With remote URLs a capability would hold for the UI server's pages too.
            assert_eq!(capability.get("remote"), None, "{text}");
            let permissions = capability["permissions"].as_array().unwrap();
            if permissions.iter().any(|p| p.as_str().unwrap().starts_with("allow-pty-")) {
                assert_eq!(capability["windows"], json!([format!("{LABEL}*")]), "{text}");
                terminal = true;
            }
        }
        assert!(terminal);
    }
}
