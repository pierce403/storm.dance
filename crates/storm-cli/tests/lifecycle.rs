use std::{fs, process::Command};

use tempfile::tempdir;

fn run(home: &std::path::Path, arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_stormdance"))
        .env("STORMDANCE_HOME", home)
        .args(arguments)
        .output()
        .expect("run stormdance")
}

#[test]
fn link_sync_status_doctor_and_unlink_are_filesystem_first() {
    let temporary = tempdir().expect("temporary directory");
    let home = temporary.path().join("home");
    let vault = temporary.path().join("vault");
    let auth = run(&home, &["--json", "auth", "init", "--inbox-id", "inbox-1"]);
    assert!(
        auth.status.success(),
        "{}",
        String::from_utf8_lossy(&auth.stderr)
    );
    let link = run(
        &home,
        &[
            "--json",
            "link",
            "notebook-1",
            vault.to_str().expect("vault path"),
            "--conversation-id",
            "group-1",
            "--name",
            "Research",
        ],
    );
    assert!(
        link.status.success(),
        "{}",
        String::from_utf8_lossy(&link.stderr)
    );
    fs::create_dir_all(vault.join("Sources")).expect("create nested folder");
    fs::write(
        vault.join("Sources/libxmtp.md"),
        "---\ntags: [xmtp]\n---\n# libxmtp\n\n[[Protocol]]\n",
    )
    .expect("write note as an agent would");
    let sync = run(
        &home,
        &["--json", "sync", vault.to_str().expect("vault path")],
    );
    assert!(
        sync.status.success(),
        "{}",
        String::from_utf8_lossy(&sync.stderr)
    );
    let sync_json: serde_json::Value = serde_json::from_slice(&sync.stdout).expect("sync JSON");
    assert_eq!(sync_json["upserts"], 1);
    let output = fs::read_to_string(vault.join("Sources/libxmtp.md")).expect("read note");
    assert!(output.starts_with("---\ntags: [xmtp]\n---\n<!-- stormdance:"));

    for command in ["status", "doctor"] {
        let output = run(
            &home,
            &["--json", command, vault.to_str().expect("vault path")],
        );
        assert!(
            output.status.success(),
            "{command}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let unlink = run(
        &home,
        &["--json", "unlink", vault.to_str().expect("vault path")],
    );
    assert!(unlink.status.success());
    assert!(vault.join("Sources/libxmtp.md").exists());
}

#[test]
fn json_mode_returns_structured_errors_without_prompts() {
    let temporary = tempdir().expect("temporary directory");
    let output = run(
        temporary.path(),
        &["--json", "doctor", temporary.path().to_str().expect("path")],
    );
    assert!(!output.status.success());
    let error: serde_json::Value = serde_json::from_slice(&output.stdout).expect("error JSON");
    assert_eq!(error["ok"], false);
    assert!(error["error"]
        .as_str()
        .expect("error text")
        .contains("linked"));
}
