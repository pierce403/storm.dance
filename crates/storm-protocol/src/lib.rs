//! Strict codec for `stormdance-sync/1` text messages.

use std::collections::{HashMap, VecDeque};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROTOCOL: &str = "storm.dance/yjs";
pub const PROTOCOL_VERSION: u32 = 1;
pub const PROTOCOL_PREFIX: &str = "stormdance-sync/1\n";
pub const DEFAULT_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_CHUNK_BYTES: usize = 512 * 1024;
pub const MAX_CHUNKS: usize = 128;
pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_WIRE_CHARS: usize = 800_000;
const MAX_ID_LENGTH: usize = 256;
const MAX_NAME_LENGTH: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("not a storm.dance sync message")]
    WrongPrefix,
    #[error("protocol message contains invalid JSON: {0}")]
    InvalidJson(String),
    #[error("invalid protocol message: {0}")]
    Invalid(String),
    #[error("protocol reassembly limit exceeded: {0}")]
    Limit(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageKind {
    Manifest,
    SyncRequest,
    Update,
    Snapshot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageHeader {
    pub notebook_id: String,
    pub message_id: String,
    pub sent_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogicalMessage {
    Manifest {
        header: MessageHeader,
        notebook_name: String,
        schema_version: u32,
        owner_inbox_id: Option<String>,
    },
    SyncRequest {
        header: MessageHeader,
        request_id: String,
        target_inbox_id: Option<String>,
        state_vector: Vec<u8>,
    },
    Update {
        header: MessageHeader,
        request_id: Option<String>,
        target_inbox_id: Option<String>,
        responder_state_vector: Option<Vec<u8>>,
        update: Vec<u8>,
    },
    Snapshot {
        header: MessageHeader,
        request_id: Option<String>,
        target_inbox_id: Option<String>,
        update: Vec<u8>,
    },
}

impl LogicalMessage {
    pub fn header(&self) -> &MessageHeader {
        match self {
            Self::Manifest { header, .. }
            | Self::SyncRequest { header, .. }
            | Self::Update { header, .. }
            | Self::Snapshot { header, .. } => header,
        }
    }

    pub fn kind(&self) -> MessageKind {
        match self {
            Self::Manifest { .. } => MessageKind::Manifest,
            Self::SyncRequest { .. } => MessageKind::SyncRequest,
            Self::Update { .. } => MessageKind::Update,
            Self::Snapshot { .. } => MessageKind::Snapshot,
        }
    }

    pub fn payload(&self) -> &[u8] {
        match self {
            Self::Manifest { .. } => &[],
            Self::SyncRequest { state_vector, .. } => state_vector,
            Self::Update { update, .. } | Self::Snapshot { update, .. } => update,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolChunk {
    pub protocol: String,
    pub version: u32,
    pub notebook_id: String,
    pub message_id: String,
    pub sent_at: u64,
    pub chunk_index: usize,
    pub chunk_count: usize,
    pub total_bytes: usize,
    pub payload: String,
    pub kind: MessageKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notebook_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_inbox_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_inbox_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responder_state_vector: Option<String>,
}

fn bounded(value: &str, label: &str, maximum: usize) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > maximum {
        return Err(ProtocolError::Invalid(format!(
            "{label} must contain 1 to {maximum} bytes"
        )));
    }
    Ok(())
}

fn validate_optional(value: Option<&str>, label: &str) -> Result<(), ProtocolError> {
    if let Some(value) = value {
        bounded(value, label, MAX_ID_LENGTH)?;
    }
    Ok(())
}

fn decode_base64(value: &str) -> Result<Vec<u8>, ProtocolError> {
    let decoded = BASE64
        .decode(value)
        .map_err(|_| ProtocolError::Invalid("payload is not canonical base64".to_owned()))?;
    if BASE64.encode(&decoded) != value {
        return Err(ProtocolError::Invalid(
            "payload is not canonical base64".to_owned(),
        ));
    }
    Ok(decoded)
}

fn validate_chunk(chunk: &ProtocolChunk) -> Result<Vec<u8>, ProtocolError> {
    if chunk.protocol != PROTOCOL || chunk.version != PROTOCOL_VERSION {
        return Err(ProtocolError::Invalid(
            "unsupported protocol version".to_owned(),
        ));
    }
    bounded(&chunk.notebook_id, "notebookId", MAX_ID_LENGTH)?;
    bounded(&chunk.message_id, "messageId", MAX_ID_LENGTH)?;
    if chunk.sent_at > MAX_SAFE_INTEGER {
        return Err(ProtocolError::Invalid(
            "sentAt is outside JS safe range".to_owned(),
        ));
    }
    if chunk.chunk_count == 0 || chunk.chunk_count > MAX_CHUNKS {
        return Err(ProtocolError::Invalid("invalid chunkCount".to_owned()));
    }
    if chunk.chunk_index >= chunk.chunk_count {
        return Err(ProtocolError::Invalid(
            "chunkIndex must be less than chunkCount".to_owned(),
        ));
    }
    if chunk.total_bytes > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::Invalid("payload is too large".to_owned()));
    }
    let payload = decode_base64(&chunk.payload)?;
    if payload.len() > MAX_CHUNK_BYTES || payload.len() > chunk.total_bytes {
        return Err(ProtocolError::Invalid(
            "decoded chunk has invalid size".to_owned(),
        ));
    }
    if chunk.total_bytes == 0 && (chunk.chunk_count != 1 || !payload.is_empty()) {
        return Err(ProtocolError::Invalid(
            "empty payload must use exactly one empty chunk".to_owned(),
        ));
    }

    validate_optional(chunk.owner_inbox_id.as_deref(), "ownerInboxId")?;
    validate_optional(chunk.request_id.as_deref(), "requestId")?;
    validate_optional(chunk.target_inbox_id.as_deref(), "targetInboxId")?;
    if let Some(vector) = &chunk.responder_state_vector {
        if decode_base64(vector)?.len() > MAX_CHUNK_BYTES {
            return Err(ProtocolError::Invalid(
                "responderStateVector is too large".to_owned(),
            ));
        }
    }

    match chunk.kind {
        MessageKind::Manifest => {
            let name = chunk.notebook_name.as_deref().ok_or_else(|| {
                ProtocolError::Invalid("manifest requires notebookName".to_owned())
            })?;
            bounded(name, "notebookName", MAX_NAME_LENGTH)?;
            let schema = chunk.schema_version.ok_or_else(|| {
                ProtocolError::Invalid("manifest requires schemaVersion".to_owned())
            })?;
            if schema == 0 || schema > 1_000_000 {
                return Err(ProtocolError::Invalid("invalid schemaVersion".to_owned()));
            }
            if chunk.request_id.is_some()
                || chunk.target_inbox_id.is_some()
                || chunk.responder_state_vector.is_some()
                || chunk.total_bytes != 0
            {
                return Err(ProtocolError::Invalid("invalid manifest fields".to_owned()));
            }
        }
        MessageKind::SyncRequest => {
            if chunk.request_id.is_none()
                || chunk.notebook_name.is_some()
                || chunk.schema_version.is_some()
                || chunk.owner_inbox_id.is_some()
                || chunk.responder_state_vector.is_some()
            {
                return Err(ProtocolError::Invalid(
                    "invalid sync-request fields".to_owned(),
                ));
            }
        }
        MessageKind::Update => {
            if chunk.notebook_name.is_some()
                || chunk.schema_version.is_some()
                || chunk.owner_inbox_id.is_some()
            {
                return Err(ProtocolError::Invalid("invalid update fields".to_owned()));
            }
        }
        MessageKind::Snapshot => {
            if chunk.notebook_name.is_some()
                || chunk.schema_version.is_some()
                || chunk.owner_inbox_id.is_some()
                || chunk.responder_state_vector.is_some()
            {
                return Err(ProtocolError::Invalid("invalid snapshot fields".to_owned()));
            }
        }
    }
    Ok(payload)
}

fn template(message: &LogicalMessage, chunk_count: usize, total_bytes: usize) -> ProtocolChunk {
    let header = message.header();
    let mut chunk = ProtocolChunk {
        protocol: PROTOCOL.to_owned(),
        version: PROTOCOL_VERSION,
        notebook_id: header.notebook_id.clone(),
        message_id: header.message_id.clone(),
        sent_at: header.sent_at,
        chunk_index: 0,
        chunk_count,
        total_bytes,
        payload: String::new(),
        kind: message.kind(),
        notebook_name: None,
        schema_version: None,
        owner_inbox_id: None,
        request_id: None,
        target_inbox_id: None,
        responder_state_vector: None,
    };
    match message {
        LogicalMessage::Manifest {
            notebook_name,
            schema_version,
            owner_inbox_id,
            ..
        } => {
            chunk.notebook_name = Some(notebook_name.clone());
            chunk.schema_version = Some(*schema_version);
            chunk.owner_inbox_id = owner_inbox_id.clone();
        }
        LogicalMessage::SyncRequest {
            request_id,
            target_inbox_id,
            ..
        } => {
            chunk.request_id = Some(request_id.clone());
            chunk.target_inbox_id = target_inbox_id.clone();
        }
        LogicalMessage::Update {
            request_id,
            target_inbox_id,
            responder_state_vector,
            ..
        } => {
            chunk.request_id = request_id.clone();
            chunk.target_inbox_id = target_inbox_id.clone();
            chunk.responder_state_vector = responder_state_vector
                .as_ref()
                .map(|value| BASE64.encode(value));
        }
        LogicalMessage::Snapshot {
            request_id,
            target_inbox_id,
            ..
        } => {
            chunk.request_id = request_id.clone();
            chunk.target_inbox_id = target_inbox_id.clone();
        }
    }
    chunk
}

pub fn encode_message(
    message: &LogicalMessage,
    chunk_bytes: Option<usize>,
) -> Result<Vec<String>, ProtocolError> {
    let payload = message.payload();
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::Invalid("payload is too large".to_owned()));
    }
    let chunk_bytes = chunk_bytes.unwrap_or(DEFAULT_CHUNK_BYTES);
    if chunk_bytes == 0 || chunk_bytes > MAX_CHUNK_BYTES {
        return Err(ProtocolError::Invalid(
            "invalid chunk byte limit".to_owned(),
        ));
    }
    let chunk_count = payload.len().max(1).div_ceil(chunk_bytes);
    if chunk_count > MAX_CHUNKS {
        return Err(ProtocolError::Invalid("too many chunks".to_owned()));
    }
    let base = template(message, chunk_count, payload.len());
    validate_chunk(&base)?;

    (0..chunk_count)
        .map(|index| {
            let start = index * chunk_bytes;
            let end = (start + chunk_bytes).min(payload.len());
            let mut chunk = base.clone();
            chunk.chunk_index = index;
            chunk.payload = BASE64.encode(&payload[start..end]);
            validate_chunk(&chunk)?;
            let json = serde_json::to_string(&chunk)
                .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
            let wire = format!("{PROTOCOL_PREFIX}{json}");
            if wire.len() > MAX_WIRE_CHARS {
                return Err(ProtocolError::Invalid("wire chunk is too large".to_owned()));
            }
            Ok(wire)
        })
        .collect()
}

pub fn decode_chunk(wire: &str) -> Result<ProtocolChunk, ProtocolError> {
    if wire.len() > MAX_WIRE_CHARS {
        return Err(ProtocolError::Invalid("wire chunk is too large".to_owned()));
    }
    let json = wire
        .strip_prefix(PROTOCOL_PREFIX)
        .ok_or(ProtocolError::WrongPrefix)?;
    let chunk: ProtocolChunk = serde_json::from_str(json)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    validate_chunk(&chunk)?;
    Ok(chunk)
}

#[derive(Clone)]
struct Assembly {
    header: ProtocolChunk,
    chunks: HashMap<usize, Vec<u8>>,
    buffered_bytes: usize,
    expires_at: u64,
}

pub struct Reassembler {
    ttl_ms: u64,
    max_assemblies: usize,
    max_buffered_bytes: usize,
    max_completed: usize,
    pending: HashMap<String, Assembly>,
    completed: HashMap<String, u64>,
    completed_order: VecDeque<String>,
    buffered_bytes: usize,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new(60_000, 64, MAX_PAYLOAD_BYTES, 256)
    }
}

impl Reassembler {
    pub fn new(
        ttl_ms: u64,
        max_assemblies: usize,
        max_buffered_bytes: usize,
        max_completed: usize,
    ) -> Self {
        Self {
            ttl_ms,
            max_assemblies,
            max_buffered_bytes,
            max_completed,
            pending: HashMap::new(),
            completed: HashMap::new(),
            completed_order: VecDeque::new(),
            buffered_bytes: 0,
        }
    }

    pub fn push_wire(
        &mut self,
        wire: &str,
        now_ms: u64,
    ) -> Result<Option<LogicalMessage>, ProtocolError> {
        self.push(decode_chunk(wire)?, now_ms)
    }

    pub fn push(
        &mut self,
        chunk: ProtocolChunk,
        now_ms: u64,
    ) -> Result<Option<LogicalMessage>, ProtocolError> {
        self.cleanup(now_ms);
        let payload = validate_chunk(&chunk)?;
        let key = format!(
            "{}\0{:?}\0{}",
            chunk.notebook_id, chunk.kind, chunk.message_id
        );
        if self.completed.contains_key(&key) {
            return Ok(None);
        }
        if !self.pending.contains_key(&key) {
            if self.pending.len() >= self.max_assemblies {
                return Err(ProtocolError::Limit("incomplete messages"));
            }
            let mut header = chunk.clone();
            header.chunk_index = 0;
            header.payload.clear();
            self.pending.insert(
                key.clone(),
                Assembly {
                    header,
                    chunks: HashMap::new(),
                    buffered_bytes: 0,
                    expires_at: now_ms.saturating_add(self.ttl_ms),
                },
            );
        }

        let assembly = self.pending.get_mut(&key).ok_or_else(|| {
            ProtocolError::Invalid("reassembly disappeared unexpectedly".to_owned())
        })?;
        let mut comparable = chunk.clone();
        comparable.chunk_index = 0;
        comparable.payload.clear();
        if comparable != assembly.header {
            self.discard(&key);
            return Err(ProtocolError::Invalid(
                "chunks have inconsistent metadata".to_owned(),
            ));
        }
        if let Some(existing) = assembly.chunks.get(&chunk.chunk_index) {
            if existing != &payload {
                self.discard(&key);
                return Err(ProtocolError::Invalid(
                    "duplicate chunk contains different data".to_owned(),
                ));
            }
            return Ok(None);
        }
        if assembly.buffered_bytes + payload.len() > assembly.header.total_bytes
            || self.buffered_bytes + payload.len() > self.max_buffered_bytes
        {
            self.discard(&key);
            return Err(ProtocolError::Limit("buffered bytes"));
        }
        assembly.buffered_bytes += payload.len();
        assembly.chunks.insert(chunk.chunk_index, payload);
        assembly.expires_at = now_ms.saturating_add(self.ttl_ms);
        self.buffered_bytes += assembly.chunks.get(&chunk.chunk_index).map_or(0, Vec::len);

        if assembly.chunks.len() != assembly.header.chunk_count {
            return Ok(None);
        }
        let assembly = self.pending.remove(&key).ok_or_else(|| {
            ProtocolError::Invalid("reassembly disappeared unexpectedly".to_owned())
        })?;
        self.buffered_bytes = self.buffered_bytes.saturating_sub(assembly.buffered_bytes);
        if assembly.buffered_bytes != assembly.header.total_bytes {
            return Err(ProtocolError::Invalid(
                "reassembled payload length does not match totalBytes".to_owned(),
            ));
        }
        let mut all = Vec::with_capacity(assembly.buffered_bytes);
        for index in 0..assembly.header.chunk_count {
            all.extend(
                assembly
                    .chunks
                    .get(&index)
                    .ok_or_else(|| ProtocolError::Invalid(format!("missing chunk {index}")))?,
            );
        }
        self.record_completed(key, now_ms);
        Ok(Some(to_logical(assembly.header, all)?))
    }

    fn discard(&mut self, key: &str) {
        if let Some(assembly) = self.pending.remove(key) {
            self.buffered_bytes = self.buffered_bytes.saturating_sub(assembly.buffered_bytes);
        }
    }

    fn record_completed(&mut self, key: String, now_ms: u64) {
        // A zero-sized cache is a supported way to disable completed-message
        // deduplication. Without this guard, `len() >= 0` loops forever.
        if self.max_completed == 0 {
            return;
        }
        while self.completed_order.len() >= self.max_completed {
            if let Some(oldest) = self.completed_order.pop_front() {
                self.completed.remove(&oldest);
            }
        }
        self.completed
            .insert(key.clone(), now_ms.saturating_add(self.ttl_ms));
        self.completed_order.push_back(key);
    }

    pub fn cleanup(&mut self, now_ms: u64) {
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, value)| value.expires_at <= now_ms)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.discard(&key);
        }
        self.completed.retain(|_, expiry| *expiry > now_ms);
        self.completed_order
            .retain(|key| self.completed.contains_key(key));
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffered_bytes
    }
}

fn to_logical(chunk: ProtocolChunk, payload: Vec<u8>) -> Result<LogicalMessage, ProtocolError> {
    let header = MessageHeader {
        notebook_id: chunk.notebook_id,
        message_id: chunk.message_id,
        sent_at: chunk.sent_at,
    };
    Ok(match chunk.kind {
        MessageKind::Manifest => LogicalMessage::Manifest {
            header,
            notebook_name: chunk.notebook_name.ok_or_else(|| {
                ProtocolError::Invalid("manifest missing notebookName".to_owned())
            })?,
            schema_version: chunk.schema_version.ok_or_else(|| {
                ProtocolError::Invalid("manifest missing schemaVersion".to_owned())
            })?,
            owner_inbox_id: chunk.owner_inbox_id,
        },
        MessageKind::SyncRequest => LogicalMessage::SyncRequest {
            header,
            request_id: chunk.request_id.ok_or_else(|| {
                ProtocolError::Invalid("sync-request missing requestId".to_owned())
            })?,
            target_inbox_id: chunk.target_inbox_id,
            state_vector: payload,
        },
        MessageKind::Update => LogicalMessage::Update {
            header,
            request_id: chunk.request_id,
            target_inbox_id: chunk.target_inbox_id,
            responder_state_vector: chunk
                .responder_state_vector
                .map(|value| decode_base64(&value))
                .transpose()?,
            update: payload,
        },
        MessageKind::Snapshot => LogicalMessage::Snapshot {
            header,
            request_id: chunk.request_id,
            target_inbox_id: chunk.target_inbox_id,
            update: payload,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> MessageHeader {
        MessageHeader {
            notebook_id: "notebook-1".to_owned(),
            message_id: "message-1".to_owned(),
            sent_at: 10,
        }
    }

    #[test]
    fn chunks_round_trip_out_of_order_and_ignore_duplicates() -> Result<(), ProtocolError> {
        let message = LogicalMessage::Update {
            header: header(),
            request_id: None,
            target_inbox_id: None,
            responder_state_vector: Some(vec![1, 2]),
            update: (0..19).collect(),
        };
        let chunks = encode_message(&message, Some(5))?;
        let mut reassembler = Reassembler::default();
        assert!(reassembler.push_wire(&chunks[1], 0)?.is_none());
        assert!(reassembler.push_wire(&chunks[1], 0)?.is_none());
        assert!(reassembler.push_wire(&chunks[3], 0)?.is_none());
        assert!(reassembler.push_wire(&chunks[0], 0)?.is_none());
        let decoded = reassembler
            .push_wire(&chunks[2], 0)?
            .expect("last chunk must complete message");
        assert_eq!(decoded, message);
        assert!(reassembler.push_wire(&chunks[0], 0)?.is_none());
        Ok(())
    }

    #[test]
    fn rejects_unknown_fields_and_noncanonical_base64() {
        let wire = format!(
            "{PROTOCOL_PREFIX}{{\"protocol\":\"{PROTOCOL}\",\"version\":1,\"notebookId\":\"n\",\"messageId\":\"m\",\"sentAt\":0,\"chunkIndex\":0,\"chunkCount\":1,\"totalBytes\":1,\"payload\":\"AB==\",\"kind\":\"update\",\"extra\":true}}"
        );
        assert!(decode_chunk(&wire).is_err());
    }

    #[test]
    fn manifest_is_one_empty_chunk() -> Result<(), ProtocolError> {
        let chunks = encode_message(
            &LogicalMessage::Manifest {
                header: header(),
                notebook_name: "Research".to_owned(),
                schema_version: 1,
                owner_inbox_id: Some("inbox".to_owned()),
            },
            None,
        )?;
        assert_eq!(chunks.len(), 1);
        assert_eq!(decode_chunk(&chunks[0])?.total_bytes, 0);
        Ok(())
    }

    #[test]
    fn zero_completed_cache_never_blocks_reassembly() -> Result<(), ProtocolError> {
        let wire = encode_message(
            &LogicalMessage::Update {
                header: header(),
                request_id: None,
                target_inbox_id: None,
                responder_state_vector: None,
                update: vec![0, 0],
            },
            None,
        )?
        .pop()
        .expect("one update chunk");
        let mut reassembler = Reassembler::new(60_000, 1, MAX_PAYLOAD_BYTES, 0);
        assert!(reassembler.push_wire(&wire, 1)?.is_some());
        // Deduplication is disabled, so a replay is processed rather than
        // hanging or retaining an entry.
        assert!(reassembler.push_wire(&wire, 2)?.is_some());
        Ok(())
    }
}
