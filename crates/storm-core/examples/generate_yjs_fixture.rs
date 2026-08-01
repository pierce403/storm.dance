use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::json;
use yrs::{
    updates::{decoder::Decode, encoder::Encode},
    ClientID, Doc, Map, MapPrelim, OffsetKind, Options, ReadTxn, StateVector, Text, TextPrelim,
    Transact,
};

const NOTEBOOK_ID: &str = "rust-fixture-notebook-v1";
const CLIENT_ID: u64 = 0x5060_7080;
const BASE_TIMESTAMP: u64 = 1_725_100_000_000;
const UPDATE_TIMESTAMP: u64 = 1_725_100_000_100;

fn binary(bytes: &[u8]) -> serde_json::Value {
    json!({
        "encoding": "base64",
        "byteLength": bytes.len(),
        "data": BASE64.encode(bytes),
    })
}

fn projection(content: &str, updated_at: u64) -> serde_json::Value {
    json!({
        "schemaVersion": 1,
        "notebook": {
            "id": NOTEBOOK_ID,
            "name": "Yrs producer fixture",
            "createdAt": BASE_TIMESTAMP,
            "updatedAt": updated_at,
        },
        "notes": [{
            "id": "rust-note",
            "title": "Native interoperability",
            "content": content,
            "folderId": null,
            "createdAt": BASE_TIMESTAMP + 1,
            "updatedAt": updated_at,
            "deleted": false,
            "deletedAt": null,
        }],
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut options = Options::with_client_id(ClientID::new(CLIENT_ID));
    options.guid = format!("stormdance:notebook:{NOTEBOOK_ID}").into();
    options.offset_kind = OffsetKind::Utf16;
    let doc = Doc::with_options(options);
    let metadata = doc.get_or_insert_map("notebook");
    let notes = doc.get_or_insert_map("notes");

    let (note, content) = {
        let mut txn = doc.transact_mut();
        metadata.insert(&mut txn, "schemaVersion", 1.0);
        metadata.insert(&mut txn, "id", NOTEBOOK_ID);
        metadata.insert(&mut txn, "name", "Yrs producer fixture");
        metadata.insert(&mut txn, "createdAt", BASE_TIMESTAMP as f64);
        metadata.insert(&mut txn, "updatedAt", BASE_TIMESTAMP as f64);

        let note = notes.insert(&mut txn, "rust-note", MapPrelim::default());
        let title = note.insert(&mut txn, "title", TextPrelim::new(""));
        title.insert(&mut txn, 0, "Native interoperability");
        let content = note.insert(&mut txn, "content", TextPrelim::new(""));
        content.insert(&mut txn, 0, "Hello from Yrs 🦀");
        note.insert(&mut txn, "folderId", yrs::Any::Null);
        note.insert(&mut txn, "createdAt", (BASE_TIMESTAMP + 1) as f64);
        note.insert(&mut txn, "updatedAt", BASE_TIMESTAMP as f64);
        note.insert(&mut txn, "deleted", false);
        note.insert(&mut txn, "deletedAt", yrs::Any::Null);
        (note, content)
    };

    let full_update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let base_state_vector = doc.transact().state_vector().encode_v1();
    let decoded_base_vector = StateVector::decode_v1(&base_state_vector)?;

    {
        let mut txn = doc.transact_mut();
        content.insert(&mut txn, 0, "Incremental native edit. ");
        note.insert(&mut txn, "updatedAt", UPDATE_TIMESTAMP as f64);
        metadata.insert(&mut txn, "updatedAt", UPDATE_TIMESTAMP as f64);
    }
    let incremental_update = doc
        .transact()
        .encode_state_as_update_v1(&decoded_base_vector);
    let updated_state_vector = doc.transact().state_vector().encode_v1();

    let fixture = json!({
        "fixtureFormat": "storm.dance/yrs-v1-producer",
        "fixtureVersion": 1,
        "producer": {
            "runtime": "rust",
            "library": "yrs",
            "libraryVersion": "0.27.3",
            "clientId": CLIENT_ID,
            "command": "cargo run --locked -p storm-core --example generate_yjs_fixture",
        },
        "notebookId": NOTEBOOK_ID,
        "fullState": {
            "update": binary(&full_update),
            "stateVector": binary(&base_state_vector),
            "expectedProjection": projection("Hello from Yrs 🦀", BASE_TIMESTAMP),
        },
        "incremental": {
            "update": binary(&incremental_update),
            "afterStateVector": binary(&updated_state_vector),
            "expectedProjection": projection(
                "Incremental native edit. Hello from Yrs 🦀",
                UPDATE_TIMESTAMP,
            ),
        },
    });
    println!("{}", serde_json::to_string_pretty(&fixture)?);
    Ok(())
}
