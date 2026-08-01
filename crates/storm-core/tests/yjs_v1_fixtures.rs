use std::{fs, path::PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::Value;
use storm_core::NotebookCrdt;

fn fixtures() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/yjs-v1/fixtures.json");
    serde_json::from_slice(&fs::read(path).expect("read Yjs fixtures")).expect("parse Yjs fixtures")
}

fn bytes(value: &Value) -> Vec<u8> {
    BASE64
        .decode(value["data"].as_str().expect("binary fixture data"))
        .expect("decode canonical base64 fixture")
}

fn assert_projection(replica: &NotebookCrdt, expected: &Value) {
    assert_eq!(
        serde_json::to_value(replica.snapshot().expect("project Yrs document"))
            .expect("serialize projection"),
        *expected
    );
}

#[test]
fn consumes_yjs_full_incremental_and_tombstone_updates() {
    let fixtures = fixtures();
    let notebook_id = fixtures["ids"]["notebookId"]
        .as_str()
        .expect("notebook fixture ID");
    let cases = &fixtures["cases"];
    let replica = NotebookCrdt::from_update(notebook_id, &bytes(&cases["fullState"]["update"]))
        .expect("apply browser full state");
    assert_projection(&replica, &cases["fullState"]["expectedProjection"]);
    assert_eq!(
        replica.encode_state_vector_v1(),
        bytes(&cases["fullState"]["stateVector"])
    );

    replica
        .apply_update_v1(&bytes(&cases["incremental"]["update"]))
        .expect("apply browser incremental update");
    assert_projection(&replica, &cases["incremental"]["expectedProjection"]);
    assert_eq!(
        replica.encode_state_vector_v1(),
        bytes(&cases["incremental"]["afterStateVector"])
    );

    replica
        .apply_update_v1(&bytes(&cases["tombstone"]["update"]))
        .expect("apply browser tombstone update");
    assert_projection(&replica, &cases["tombstone"]["expectedProjection"]);
    assert_eq!(
        replica.encode_state_vector_v1(),
        bytes(&cases["tombstone"]["afterStateVector"])
    );
}

#[test]
fn consumes_concurrent_yjs_updates_in_both_orders() {
    let fixtures = fixtures();
    let notebook_id = fixtures["ids"]["notebookId"]
        .as_str()
        .expect("notebook fixture ID");
    let cases = &fixtures["cases"];
    for updates in [["leftUpdate", "rightUpdate"], ["rightUpdate", "leftUpdate"]] {
        let replica = NotebookCrdt::from_update(notebook_id, &bytes(&cases["fullState"]["update"]))
            .expect("apply browser base");
        for update in updates {
            replica
                .apply_update_v1(&bytes(&cases["concurrency"][update]))
                .expect("apply concurrent browser update");
        }
        assert_projection(&replica, &cases["concurrency"]["expectedProjection"]);
        // State-vector entries are a map; Yjs and Yrs may encode that map in
        // different iteration orders. An empty mutual delta proves semantic
        // equality without treating byte ordering as canonical.
        assert_eq!(
            replica
                .encode_diff_v1(&bytes(&cases["concurrency"]["mergedStateVector"]))
                .expect("diff against browser state vector"),
            vec![0, 0]
        );
    }
}
