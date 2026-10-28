fn main() {
    // Listing the commands puts each behind a permission, so only the app's own pages that a
    // capability names may call them, and the web UI none.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "capture",
            "dismiss",
            "retry",
            "pty_open",
            "pty_write",
            "pty_resize",
        ]),
    ))
    .expect("failed to run tauri-build");
}
