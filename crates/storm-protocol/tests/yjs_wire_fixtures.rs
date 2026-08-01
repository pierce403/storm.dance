use std::{fs, path::PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::Value;
use storm_protocol::{LogicalMessage, Reassembler};

fn fixtures() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/yjs-v1/fixtures.json");
    serde_json::from_slice(&fs::read(path).expect("read Yjs fixtures")).expect("parse Yjs fixtures")
}

#[test]
fn reassembles_browser_wire_chunks_without_typescript_translation() {
    let fixtures = fixtures();
    let protocol = &fixtures["protocol"];
    let order = protocol["updateDeliveryOrder"]
        .as_array()
        .expect("delivery order");
    let chunks = protocol["updateChunks"].as_array().expect("update chunks");
    let mut reassembler = Reassembler::default();
    let mut decoded = None;
    for index in order {
        let wire = chunks[index.as_u64().expect("chunk index") as usize]
            .as_str()
            .expect("wire chunk");
        if let Some(message) = reassembler
            .push_wire(wire, 1)
            .expect("reassemble browser chunk")
        {
            decoded = Some(message);
        }
    }
    let LogicalMessage::Update {
        update,
        responder_state_vector,
        ..
    } = decoded.expect("complete update")
    else {
        panic!("expected update fixture");
    };
    assert_eq!(
        update,
        BASE64
            .decode(
                protocol["updateMessage"]["payload"]["data"]
                    .as_str()
                    .expect("payload")
            )
            .expect("payload base64")
    );
    assert_eq!(
        responder_state_vector.expect("responder state vector"),
        BASE64
            .decode(
                protocol["updateMessage"]["responderStateVector"]["data"]
                    .as_str()
                    .expect("state vector")
            )
            .expect("state vector base64")
    );

    for name in ["manifestChunks", "syncRequestChunks", "snapshotChunks"] {
        let mut reassembler = Reassembler::default();
        let mut message = None;
        for wire in protocol[name].as_array().expect("fixture chunks") {
            if let Some(value) = reassembler
                .push_wire(wire.as_str().expect("wire"), 2)
                .expect("decode browser wire")
            {
                message = Some(value);
            }
        }
        assert!(message.is_some(), "{name} did not reassemble");
    }
}
