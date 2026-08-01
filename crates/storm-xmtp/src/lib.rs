//! Transport boundary between storm.dance CRDT synchronization and XMTP.
//!
//! `XmtpTransport` is intentionally narrower than any language SDK. The web
//! implementation, a future direct libxmtp adapter, and deterministic tests all
//! exercise the same protocol state machine.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    pin::Pin,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use futures::{Stream, StreamExt};
use storm_core::{CoreError, NotebookCrdt};
use storm_protocol::{
    encode_message, LogicalMessage, MessageHeader, ProtocolError, Reassembler, PROTOCOL_PREFIX,
};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

pub const GROUP_DESCRIPTION_PREFIX: &str = "storm.dance/yjs/1/";
pub const HISTORY_LIMIT: usize = 2_048;
pub const LIBXMTP_PINNED_REV: &str = "66944e28f1d19269be7af0e11e165492f61a2b19";
const MAX_OWN_MESSAGE_IDS: usize = 512;
const MAX_ACTIVE_REQUEST_IDS: usize = 64;
const MAX_RESPONSES_PER_REQUEST: usize = 256;
const MAX_QUARANTINED_MESSAGES: usize = 128;
const MAX_QUARANTINE_FIELD_CHARS: usize = 1_024;

pub type MessageStream =
    Pin<Box<dyn Stream<Item = Result<TransportMessage, TransportError>> + Send>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotebookGroup {
    pub id: String,
    pub description: String,
}

impl NotebookGroup {
    pub fn notebook_id(&self) -> Option<String> {
        self.description
            .strip_prefix(GROUP_DESCRIPTION_PREFIX)
            .filter(|value| !value.is_empty())
            .and_then(percent_decode)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransportMessage {
    pub id: String,
    pub group_id: String,
    pub sender_inbox_id: String,
    pub sent_at: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantinedMessage {
    pub transport_message_id: String,
    pub sender_inbox_id: String,
    pub error: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum TransportError {
    #[error("XMTP transport is unavailable: {0}")]
    Unavailable(String),
    #[error("XMTP group was not found: {0}")]
    GroupNotFound(String),
    #[error("XMTP stream lagged by {0} messages")]
    Lagged(u64),
    #[error("XMTP transport rejected the operation: {0}")]
    Rejected(String),
}

#[derive(Debug, Error)]
pub enum SyncError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("XMTP group {actual} does not match configured group {expected}")]
    GroupMismatch { expected: String, actual: String },
    #[error("protocol message belongs to notebook {actual}, not {expected}")]
    NotebookMismatch { expected: String, actual: String },
    #[error("XMTP group binding is invalid: {0}")]
    InvalidBinding(String),
    #[error("timed out waiting for an XMTP state-vector response")]
    Timeout,
}

impl SyncError {
    fn is_quarantinable(&self) -> bool {
        matches!(
            self,
            Self::Protocol(_) | Self::Core(_) | Self::NotebookMismatch { .. }
        )
    }
}

#[async_trait]
pub trait XmtpTransport: Send + Sync + 'static {
    async fn inbox_id(&self) -> Result<String, TransportError>;
    async fn list_groups(&self) -> Result<Vec<NotebookGroup>, TransportError>;
    async fn sync_group(&self, group_id: &str) -> Result<(), TransportError>;
    async fn history(
        &self,
        group_id: &str,
        limit: usize,
    ) -> Result<Vec<TransportMessage>, TransportError>;
    async fn send_text(&self, group_id: &str, text: String) -> Result<String, TransportError>;
    async fn stream(&self, group_id: &str) -> Result<MessageStream, TransportError>;
}

pub fn discover_notebooks(groups: &[NotebookGroup]) -> Vec<(String, NotebookGroup)> {
    let mut notebooks: Vec<_> = groups
        .iter()
        .filter_map(|group| group.notebook_id().map(|id| (id, group.clone())))
        .collect();
    notebooks.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.id.cmp(&right.1.id)));
    notebooks
}

/// Stateful protocol peer for one notebook/group binding.
pub struct SyncEngine<T: XmtpTransport> {
    transport: Arc<T>,
    notebook_id: String,
    group_id: String,
    own_message_ids: Mutex<BoundedIds>,
    active_request_ids: Mutex<ActiveRequests>,
    reassembler: Mutex<Reassembler>,
    quarantined: Mutex<VecDeque<QuarantinedMessage>>,
}

impl<T: XmtpTransport> SyncEngine<T> {
    pub fn new(
        transport: Arc<T>,
        notebook_id: impl Into<String>,
        group_id: impl Into<String>,
    ) -> Self {
        Self {
            transport,
            notebook_id: notebook_id.into(),
            group_id: group_id.into(),
            own_message_ids: Mutex::new(BoundedIds::new(MAX_OWN_MESSAGE_IDS)),
            active_request_ids: Mutex::new(ActiveRequests::new(MAX_ACTIVE_REQUEST_IDS)),
            reassembler: Mutex::new(Reassembler::default()),
            quarantined: Mutex::new(VecDeque::new()),
        }
    }

    pub fn quarantined_messages(&self) -> Result<Vec<QuarantinedMessage>, SyncError> {
        Ok(self
            .quarantined
            .lock()
            .map_err(|_| TransportError::Unavailable("quarantine lock poisoned".to_owned()))?
            .iter()
            .cloned()
            .collect())
    }

    /// Replays durable history and announces a state-vector request. This does
    /// not wait for a live peer; use [`Self::sync_roundtrip`] when a finite,
    /// acknowledged catch-up is required.
    pub async fn announce_catch_up(
        &self,
        replica: &NotebookCrdt,
        now: u64,
    ) -> Result<String, SyncError> {
        self.validate_binding().await?;
        self.transport.sync_group(&self.group_id).await?;
        self.pull_history(replica).await?;
        self.request_sync(replica, now).await
    }

    #[deprecated(note = "use announce_catch_up or sync_roundtrip; this does not await a peer")]
    pub async fn sync_once(&self, replica: &NotebookCrdt, now: u64) -> Result<(), SyncError> {
        self.announce_catch_up(replica, now).await.map(|_| ())
    }

    /// Subscribe-before-history, request missing state, apply the response,
    /// send the reverse delta, and return when that exchange completes.
    pub async fn sync_roundtrip(
        &self,
        replica: &NotebookCrdt,
        now: u64,
        wait: std::time::Duration,
    ) -> Result<(), SyncError> {
        self.validate_binding().await?;
        self.transport.sync_group(&self.group_id).await?;
        let mut stream = self.transport.stream(&self.group_id).await?;
        self.pull_history(replica).await?;
        let request_id = self.request_sync(replica, now).await?;
        let deadline = tokio::time::Instant::now()
            .checked_add(wait)
            .ok_or(SyncError::Timeout)?;
        loop {
            let message = tokio::time::timeout_at(deadline, stream.next())
                .await
                .map_err(|_| SyncError::Timeout)?
                .ok_or_else(|| {
                    TransportError::Unavailable("XMTP message stream closed".to_owned())
                })??;
            let outcome = self.process_or_quarantine(replica, message, true).await?;
            if outcome.completed_request() == Some(request_id.as_str()) {
                return Ok(());
            }
        }
    }

    pub async fn pull_history(&self, replica: &NotebookCrdt) -> Result<(), SyncError> {
        let messages = self
            .transport
            .history(&self.group_id, HISTORY_LIMIT)
            .await?;
        for message in messages {
            // State-bearing messages are safe to replay. Historical sync
            // requests are stale announcements and must not trigger replies.
            self.process_or_quarantine(replica, message, false).await?;
        }
        Ok(())
    }

    pub async fn run(&self, replica: &NotebookCrdt) -> Result<(), SyncError> {
        self.validate_binding().await?;
        self.transport.sync_group(&self.group_id).await?;
        // Subscribe before history to close the history/live race window.
        let mut stream = self.transport.stream(&self.group_id).await?;
        self.pull_history(replica).await?;
        self.request_sync(replica, 0).await?;
        while let Some(message) = stream.next().await {
            self.process_or_quarantine(replica, message?, true).await?;
        }
        Ok(())
    }

    pub async fn publish_update(&self, update: Vec<u8>, now: u64) -> Result<(), SyncError> {
        self.send(LogicalMessage::Update {
            header: self.header(now),
            request_id: None,
            target_inbox_id: None,
            responder_state_vector: None,
            update,
        })
        .await
    }

    pub async fn publish_snapshot(
        &self,
        replica: &NotebookCrdt,
        now: u64,
    ) -> Result<(), SyncError> {
        self.send(LogicalMessage::Snapshot {
            header: self.header(now),
            request_id: None,
            target_inbox_id: None,
            update: replica.encode_state_as_update_v1(),
        })
        .await
    }

    pub async fn request_sync(
        &self,
        replica: &NotebookCrdt,
        now: u64,
    ) -> Result<String, SyncError> {
        let request_id = Uuid::new_v4().to_string();
        self.active_request_ids
            .lock()
            .map_err(|_| TransportError::Unavailable("request ID lock poisoned".to_owned()))?
            .insert(request_id.clone());
        let send_result = self
            .send(LogicalMessage::SyncRequest {
                header: self.header(now),
                request_id: request_id.clone(),
                target_inbox_id: None,
                state_vector: replica.encode_state_vector_v1(),
            })
            .await;
        if let Err(error) = send_result {
            self.active_request_ids
                .lock()
                .map_err(|_| TransportError::Unavailable("request ID lock poisoned".to_owned()))?
                .remove(&request_id);
            return Err(error);
        }
        Ok(request_id)
    }

    async fn process_or_quarantine(
        &self,
        replica: &NotebookCrdt,
        message: TransportMessage,
        allow_responses: bool,
    ) -> Result<ProcessOutcome, SyncError> {
        let identity = QuarantinedMessage {
            transport_message_id: bounded_diagnostic(&message.id),
            sender_inbox_id: bounded_diagnostic(&message.sender_inbox_id),
            error: String::new(),
        };
        match self
            .process_transport_message(replica, message, allow_responses)
            .await
        {
            Err(error) if error.is_quarantinable() => {
                self.quarantine(QuarantinedMessage {
                    error: bounded_diagnostic(&error.to_string()),
                    ..identity
                })?;
                Ok(ProcessOutcome::Ignored)
            }
            result => result,
        }
    }

    fn quarantine(&self, message: QuarantinedMessage) -> Result<(), SyncError> {
        let mut quarantined = self
            .quarantined
            .lock()
            .map_err(|_| TransportError::Unavailable("quarantine lock poisoned".to_owned()))?;
        while quarantined.len() >= MAX_QUARANTINED_MESSAGES {
            quarantined.pop_front();
        }
        quarantined.push_back(message);
        Ok(())
    }

    async fn process_transport_message(
        &self,
        replica: &NotebookCrdt,
        message: TransportMessage,
        allow_responses: bool,
    ) -> Result<ProcessOutcome, SyncError> {
        if message.group_id != self.group_id {
            return Err(SyncError::GroupMismatch {
                expected: self.group_id.clone(),
                actual: message.group_id,
            });
        }
        if !message.text.starts_with(PROTOCOL_PREFIX) {
            return Ok(ProcessOutcome::Ignored);
        }
        let logical = {
            let mut reassembler = self
                .reassembler
                .lock()
                .map_err(|_| TransportError::Unavailable("reassembler lock poisoned".to_owned()))?;
            reassembler.push_wire(&message.text, message.sent_at)?
        };
        let Some(logical) = logical else {
            return Ok(ProcessOutcome::Ignored);
        };
        if logical.header().notebook_id != self.notebook_id {
            return Err(SyncError::NotebookMismatch {
                expected: self.notebook_id.clone(),
                actual: logical.header().notebook_id.clone(),
            });
        }
        let own = self
            .own_message_ids
            .lock()
            .map_err(|_| TransportError::Unavailable("message ID lock poisoned".to_owned()))?
            .take(&logical.header().message_id);
        if own {
            return Ok(ProcessOutcome::Ignored);
        }
        let inbox_id = self.transport.inbox_id().await?;
        match logical {
            LogicalMessage::Manifest { .. } => Ok(ProcessOutcome::Applied),
            LogicalMessage::Snapshot {
                target_inbox_id,
                update,
                ..
            } => {
                if target_inbox_id
                    .as_deref()
                    .is_none_or(|target| target == inbox_id)
                {
                    replica.apply_update_v1(&update)?;
                    Ok(ProcessOutcome::Applied)
                } else {
                    Ok(ProcessOutcome::Ignored)
                }
            }
            LogicalMessage::Update {
                header,
                request_id,
                target_inbox_id,
                responder_state_vector,
                update,
            } => {
                if target_inbox_id
                    .as_deref()
                    .is_some_and(|target| target != inbox_id)
                {
                    return Ok(ProcessOutcome::Ignored);
                }

                let response_message_id = header.message_id;
                let should_complete = if allow_responses && responder_state_vector.is_some() {
                    if let Some(request_id) = request_id.as_ref() {
                        self.active_request_ids
                            .lock()
                            .map_err(|_| {
                                TransportError::Unavailable("request ID lock poisoned".to_owned())
                            })?
                            .is_unseen(request_id, &response_message_id)
                    } else {
                        false
                    }
                } else {
                    false
                };
                // Decode the responder vector before applying its update. A
                // malformed correlation must not mutate the local document.
                let reverse = if should_complete {
                    responder_state_vector
                        .as_deref()
                        .map(|vector| replica.encode_diff_v1(vector))
                        .transpose()?
                } else {
                    None
                };
                replica.apply_update_v1(&update)?;

                let claimed = if should_complete {
                    self.active_request_ids
                        .lock()
                        .map_err(|_| {
                            TransportError::Unavailable("request ID lock poisoned".to_owned())
                        })?
                        .mark_response(
                            request_id.as_deref().unwrap_or_default(),
                            response_message_id.clone(),
                        )
                } else {
                    false
                };
                if claimed {
                    let send_result: Result<(), SyncError> = async {
                        if let Some(reverse) = reverse {
                            if !is_empty_update(&reverse) {
                                self.send(LogicalMessage::Update {
                                    header: self.header(message.sent_at),
                                    request_id: request_id.clone(),
                                    target_inbox_id: Some(message.sender_inbox_id.clone()),
                                    responder_state_vector: None,
                                    update: reverse,
                                })
                                .await?;
                            }
                        }
                        // A targeted response is invisible to the other group
                        // members. Relay its state-bearing delta once so an
                        // earlier responder also receives later peers' edits.
                        if !is_empty_update(&update) {
                            self.send(LogicalMessage::Update {
                                header: self.header(message.sent_at),
                                request_id: None,
                                target_inbox_id: None,
                                responder_state_vector: None,
                                update: update.clone(),
                            })
                            .await?;
                        }
                        Ok(())
                    }
                    .await;
                    if let Err(error) = send_result {
                        self.active_request_ids
                            .lock()
                            .map_err(|_| {
                                TransportError::Unavailable("request ID lock poisoned".to_owned())
                            })?
                            .release_response(
                                request_id.as_deref().unwrap_or_default(),
                                &response_message_id,
                            );
                        return Err(error);
                    }
                }
                Ok(request_id
                    .filter(|_| claimed)
                    .map_or(ProcessOutcome::Applied, ProcessOutcome::CompletedRequest))
            }
            LogicalMessage::SyncRequest {
                header,
                request_id,
                target_inbox_id,
                state_vector,
            } => {
                if target_inbox_id
                    .as_deref()
                    .is_some_and(|target| target != inbox_id)
                {
                    return Ok(ProcessOutcome::Ignored);
                }
                if !allow_responses {
                    return Ok(ProcessOutcome::Ignored);
                }
                let update = replica.encode_diff_v1(&state_vector)?;
                self.send(LogicalMessage::Update {
                    header: self.header(message.sent_at),
                    request_id: Some(request_id),
                    target_inbox_id: Some(message.sender_inbox_id),
                    responder_state_vector: Some(replica.encode_state_vector_v1()),
                    update,
                })
                .await?;
                // `header` is deliberately consumed: response correlation is
                // carried by requestId rather than transport sender identity.
                let _ = header;
                Ok(ProcessOutcome::Applied)
            }
        }
    }

    fn header(&self, now: u64) -> MessageHeader {
        MessageHeader {
            notebook_id: self.notebook_id.clone(),
            message_id: Uuid::new_v4().to_string(),
            sent_at: now,
        }
    }

    async fn send(&self, message: LogicalMessage) -> Result<(), SyncError> {
        let id = message.header().message_id.clone();
        let _inserted = self
            .own_message_ids
            .lock()
            .map_err(|_| TransportError::Unavailable("message ID lock poisoned".to_owned()))?
            .insert(id);
        for wire in encode_message(&message, None)? {
            self.transport.send_text(&self.group_id, wire).await?;
        }
        Ok(())
    }

    async fn validate_binding(&self) -> Result<(), SyncError> {
        let groups = self.transport.list_groups().await?;
        let group = groups
            .into_iter()
            .find(|group| group.id == self.group_id)
            .ok_or_else(|| TransportError::GroupNotFound(self.group_id.clone()))?;
        let notebook_id = group.notebook_id().ok_or_else(|| {
            SyncError::InvalidBinding("group description is not storm.dance/yjs/1".to_owned())
        })?;
        if notebook_id != self.notebook_id {
            return Err(SyncError::InvalidBinding(format!(
                "group belongs to notebook {notebook_id}, not {}",
                self.notebook_id
            )));
        }
        Ok(())
    }
}

enum ProcessOutcome {
    Ignored,
    Applied,
    CompletedRequest(String),
}

impl ProcessOutcome {
    fn completed_request(&self) -> Option<&str> {
        match self {
            Self::CompletedRequest(value) => Some(value),
            Self::Ignored | Self::Applied => None,
        }
    }
}

struct BoundedIds {
    maximum: usize,
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl BoundedIds {
    fn new(maximum: usize) -> Self {
        Self {
            maximum,
            ids: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    fn insert(&mut self, value: String) -> bool {
        if !self.ids.insert(value.clone()) {
            return false;
        }
        self.order.push_back(value);
        while self.order.len() > self.maximum {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
        true
    }

    fn take(&mut self, value: &str) -> bool {
        self.ids.remove(value)
    }

    fn remove(&mut self, value: &str) -> bool {
        let removed = self.ids.remove(value);
        if removed {
            self.order.retain(|candidate| candidate != value);
        }
        removed
    }
}

struct ActiveRequest {
    responses: BoundedIds,
}

struct ActiveRequests {
    maximum: usize,
    requests: HashMap<String, ActiveRequest>,
    order: VecDeque<String>,
}

impl ActiveRequests {
    fn new(maximum: usize) -> Self {
        Self {
            maximum,
            requests: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn insert(&mut self, request_id: String) {
        if self.requests.contains_key(&request_id) {
            return;
        }
        self.requests.insert(
            request_id.clone(),
            ActiveRequest {
                responses: BoundedIds::new(MAX_RESPONSES_PER_REQUEST),
            },
        );
        self.order.push_back(request_id);
        while self.order.len() > self.maximum {
            if let Some(oldest) = self.order.pop_front() {
                self.requests.remove(&oldest);
            }
        }
    }

    fn remove(&mut self, request_id: &str) {
        if self.requests.remove(request_id).is_some() {
            self.order.retain(|candidate| candidate != request_id);
        }
    }

    fn is_unseen(&self, request_id: &str, response_message_id: &str) -> bool {
        self.requests
            .get(request_id)
            .is_some_and(|request| !request.responses.ids.contains(response_message_id))
    }

    fn mark_response(&mut self, request_id: &str, response_message_id: String) -> bool {
        self.requests
            .get_mut(request_id)
            .is_some_and(|request| request.responses.insert(response_message_id))
    }

    fn release_response(&mut self, request_id: &str, response_message_id: &str) {
        if let Some(request) = self.requests.get_mut(request_id) {
            request.responses.remove(response_message_id);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.requests.len()
    }
}

fn is_empty_update(update: &[u8]) -> bool {
    update == [0, 0]
}

fn bounded_diagnostic(value: &str) -> String {
    value.chars().take(MAX_QUARANTINE_FIELD_CHARS).collect()
}

#[derive(Default)]
struct MemoryState {
    groups: HashMap<String, NotebookGroup>,
    messages: HashMap<String, Vec<TransportMessage>>,
    streams: HashMap<String, broadcast::Sender<TransportMessage>>,
    clock: u64,
}

#[derive(Clone, Default)]
pub struct MemoryBroker(Arc<Mutex<MemoryState>>);

impl MemoryBroker {
    pub fn create_group(&self, id: impl Into<String>, notebook_id: &str) -> NotebookGroup {
        let group = NotebookGroup {
            id: id.into(),
            description: format!("{GROUP_DESCRIPTION_PREFIX}{}", percent_encode(notebook_id)),
        };
        if let Ok(mut state) = self.0.lock() {
            state.groups.insert(group.id.clone(), group.clone());
            state.messages.entry(group.id.clone()).or_default();
            state
                .streams
                .entry(group.id.clone())
                .or_insert_with(|| broadcast::channel(1024).0);
        }
        group
    }

    pub fn endpoint(&self, inbox_id: impl Into<String>) -> MemoryTransport {
        MemoryTransport {
            inbox_id: inbox_id.into(),
            broker: self.clone(),
        }
    }
}

#[derive(Clone)]
pub struct MemoryTransport {
    inbox_id: String,
    broker: MemoryBroker,
}

#[async_trait]
impl XmtpTransport for MemoryTransport {
    async fn inbox_id(&self) -> Result<String, TransportError> {
        Ok(self.inbox_id.clone())
    }

    async fn list_groups(&self) -> Result<Vec<NotebookGroup>, TransportError> {
        let state =
            self.broker.0.lock().map_err(|_| {
                TransportError::Unavailable("memory broker lock poisoned".to_owned())
            })?;
        let mut groups: Vec<_> = state.groups.values().cloned().collect();
        groups.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(groups)
    }

    async fn sync_group(&self, group_id: &str) -> Result<(), TransportError> {
        let state =
            self.broker.0.lock().map_err(|_| {
                TransportError::Unavailable("memory broker lock poisoned".to_owned())
            })?;
        if state.groups.contains_key(group_id) {
            Ok(())
        } else {
            Err(TransportError::GroupNotFound(group_id.to_owned()))
        }
    }

    async fn history(
        &self,
        group_id: &str,
        limit: usize,
    ) -> Result<Vec<TransportMessage>, TransportError> {
        let state =
            self.broker.0.lock().map_err(|_| {
                TransportError::Unavailable("memory broker lock poisoned".to_owned())
            })?;
        let messages = state
            .messages
            .get(group_id)
            .ok_or_else(|| TransportError::GroupNotFound(group_id.to_owned()))?;
        Ok(messages[messages.len().saturating_sub(limit)..].to_vec())
    }

    async fn send_text(&self, group_id: &str, text: String) -> Result<String, TransportError> {
        let mut state =
            self.broker.0.lock().map_err(|_| {
                TransportError::Unavailable("memory broker lock poisoned".to_owned())
            })?;
        if !state.groups.contains_key(group_id) {
            return Err(TransportError::GroupNotFound(group_id.to_owned()));
        }
        state.clock += 1;
        let message = TransportMessage {
            id: Uuid::new_v4().to_string(),
            group_id: group_id.to_owned(),
            sender_inbox_id: self.inbox_id.clone(),
            sent_at: state.clock,
            text,
        };
        state
            .messages
            .entry(group_id.to_owned())
            .or_default()
            .push(message.clone());
        if let Some(sender) = state.streams.get(group_id) {
            let _ = sender.send(message.clone());
        }
        Ok(message.id)
    }

    async fn stream(&self, group_id: &str) -> Result<MessageStream, TransportError> {
        let receiver = {
            let state = self.broker.0.lock().map_err(|_| {
                TransportError::Unavailable("memory broker lock poisoned".to_owned())
            })?;
            state
                .streams
                .get(group_id)
                .ok_or_else(|| TransportError::GroupNotFound(group_id.to_owned()))?
                .subscribe()
        };
        Ok(
            futures::stream::unfold(receiver, |mut receiver| async move {
                match receiver.recv().await {
                    Ok(message) => Some((Ok(message), receiver)),
                    Err(broadcast::error::RecvError::Lagged(count)) => {
                        Some((Err(TransportError::Lagged(count)), receiver))
                    }
                    Err(broadcast::error::RecvError::Closed) => None,
                }
            })
            .boxed(),
        )
    }
}

/// Adapter boundary for the pinned upstream libxmtp workspace.
///
/// Upstream currently marks all Rust crates `publish = false`, requires Rust
/// 1.94, and uses internal workspace/path plus pinned git dependencies. There
/// is therefore no stable crate that storm.dance can responsibly expose in its
/// default build. Applications enabling `libxmtp` supply a driver compiled
/// against [`LIBXMTP_PINNED_REV`]; this wrapper keeps the rest of storm.dance
/// insulated from upstream API churn.
#[cfg(feature = "libxmtp")]
pub struct LibxmtpTransport<D> {
    driver: D,
}

#[cfg(feature = "libxmtp")]
impl<D> LibxmtpTransport<D> {
    pub fn new(driver: D) -> Self {
        Self { driver }
    }

    pub fn driver(&self) -> &D {
        &self.driver
    }
}

#[cfg(feature = "libxmtp")]
#[async_trait]
pub trait LibxmtpDriver: Send + Sync + 'static {
    async fn inbox_id(&self) -> Result<String, TransportError>;
    async fn groups(&self) -> Result<Vec<NotebookGroup>, TransportError>;
    async fn sync_group(&self, group_id: &str) -> Result<(), TransportError>;
    async fn messages(
        &self,
        group_id: &str,
        limit: usize,
    ) -> Result<Vec<TransportMessage>, TransportError>;
    async fn send(&self, group_id: &str, text: String) -> Result<String, TransportError>;
    async fn subscribe(&self, group_id: &str) -> Result<MessageStream, TransportError>;
}

#[cfg(feature = "libxmtp")]
#[async_trait]
impl<D: LibxmtpDriver> XmtpTransport for LibxmtpTransport<D> {
    async fn inbox_id(&self) -> Result<String, TransportError> {
        self.driver.inbox_id().await
    }
    async fn list_groups(&self) -> Result<Vec<NotebookGroup>, TransportError> {
        self.driver.groups().await
    }
    async fn sync_group(&self, group_id: &str) -> Result<(), TransportError> {
        self.driver.sync_group(group_id).await
    }
    async fn history(
        &self,
        group_id: &str,
        limit: usize,
    ) -> Result<Vec<TransportMessage>, TransportError> {
        self.driver.messages(group_id, limit).await
    }
    async fn send_text(&self, group_id: &str, text: String) -> Result<String, TransportError> {
        self.driver.send(group_id, text).await
    }
    async fn stream(&self, group_id: &str) -> Result<MessageStream, TransportError> {
        self.driver.subscribe(group_id).await
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                vec![byte as char]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let byte = u8::from_str_radix(&value[index + 1..index + 3], 16).ok()?;
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use storm_core::{Note, NotebookSeed};

    fn seed(replica: &NotebookCrdt) {
        replica
            .seed(
                &NotebookSeed {
                    id: "notebook".to_owned(),
                    name: "Research".to_owned(),
                    created_at: 1,
                    updated_at: 1,
                },
                &[Note {
                    id: "note".to_owned(),
                    title: "Design".to_owned(),
                    content: "base".to_owned(),
                    folder_id: None,
                    created_at: 1,
                    updated_at: 1,
                    deleted: false,
                    deleted_at: None,
                }],
            )
            .expect("seed replica");
    }

    #[tokio::test]
    async fn two_transports_exchange_snapshots_and_incremental_updates() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "notebook");
        let alice = Arc::new(broker.endpoint("alice-inbox"));
        let bob = Arc::new(broker.endpoint("bob-inbox"));
        let alice_sync = SyncEngine::new(alice, "notebook", "group");
        let bob_sync = SyncEngine::new(bob, "notebook", "group");
        let left = NotebookCrdt::new("notebook").expect("left replica");
        let right = NotebookCrdt::new("notebook").expect("right replica");
        seed(&left);
        alice_sync
            .publish_snapshot(&left, 1)
            .await
            .expect("publish snapshot");
        bob_sync
            .pull_history(&right)
            .await
            .expect("receive snapshot");
        assert_eq!(
            left.snapshot().expect("left"),
            right.snapshot().expect("right")
        );

        let left_before = left.encode_state_vector_v1();
        let right_before = right.encode_state_vector_v1();
        let mut left_note = left.snapshot().expect("left projection").notes[0].clone();
        left_note.content = "left edit".to_owned();
        left_note.updated_at = 2;
        left.upsert_note(&left_note).expect("left edit");
        let mut right_note = right.snapshot().expect("right projection").notes[0].clone();
        right_note.title = "Right title".to_owned();
        right_note.updated_at = 3;
        right.upsert_note(&right_note).expect("right edit");
        alice_sync
            .publish_update(left.encode_diff_v1(&left_before).expect("left delta"), 2)
            .await
            .expect("send left delta");
        bob_sync
            .publish_update(right.encode_diff_v1(&right_before).expect("right delta"), 3)
            .await
            .expect("send right delta");
        alice_sync.pull_history(&left).await.expect("left catchup");
        bob_sync.pull_history(&right).await.expect("right catchup");
        assert_eq!(
            left.snapshot().expect("left"),
            right.snapshot().expect("right")
        );
    }

    #[tokio::test]
    async fn state_vector_handshake_sends_the_reverse_delta() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "notebook");
        let alice_transport = Arc::new(broker.endpoint("alice-inbox"));
        let bob_transport = Arc::new(broker.endpoint("bob-inbox"));
        let alice_sync = SyncEngine::new(Arc::clone(&alice_transport), "notebook", "group");
        let bob_sync = SyncEngine::new(Arc::clone(&bob_transport), "notebook", "group");
        let left = NotebookCrdt::new("notebook").expect("left replica");
        seed(&left);
        let right = NotebookCrdt::from_update("notebook", &left.encode_state_as_update_v1())
            .expect("right replica");

        let mut left_note = left.snapshot().expect("left projection").notes[0].clone();
        left_note.content = "left-only content".to_owned();
        left.upsert_note(&left_note).expect("left edit");
        let mut right_note = right.snapshot().expect("right projection").notes[0].clone();
        right_note.title = "right-only title".to_owned();
        right.upsert_note(&right_note).expect("right edit");

        let request_id = bob_sync
            .request_sync(&right, 10)
            .await
            .expect("announce state vector");
        let request = bob_transport
            .history("group", 1)
            .await
            .expect("request history")
            .pop()
            .expect("request message");
        alice_sync
            .process_transport_message(&left, request, true)
            .await
            .expect("respond to live request");
        let response = alice_transport
            .history("group", 1)
            .await
            .expect("response history")
            .pop()
            .expect("response message");
        let outcome = bob_sync
            .process_transport_message(&right, response, true)
            .await
            .expect("apply response and send reverse delta");
        assert_eq!(outcome.completed_request(), Some(request_id.as_str()));
        let resulting_messages = bob_transport
            .history("group", 2)
            .await
            .expect("reverse and relay history");
        for message in resulting_messages {
            alice_sync
                .process_transport_message(&left, message, true)
                .await
                .expect("apply reverse delta or relayed response");
        }
        assert_eq!(
            left.snapshot().expect("left"),
            right.snapshot().expect("right")
        );
    }

    #[tokio::test]
    async fn three_peers_converge_from_one_broadcast_state_vector_request() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "notebook");
        let alice_transport = Arc::new(broker.endpoint("alice-inbox"));
        let bob_transport = Arc::new(broker.endpoint("bob-inbox"));
        let carol_transport = Arc::new(broker.endpoint("carol-inbox"));
        let alice_sync = SyncEngine::new(Arc::clone(&alice_transport), "notebook", "group");
        let bob_sync = SyncEngine::new(Arc::clone(&bob_transport), "notebook", "group");
        let carol_sync = SyncEngine::new(Arc::clone(&carol_transport), "notebook", "group");

        let alice = NotebookCrdt::new("notebook").expect("alice replica");
        seed(&alice);
        let base = alice.encode_state_as_update_v1();
        let bob = NotebookCrdt::from_update("notebook", &base).expect("bob replica");
        let carol = NotebookCrdt::from_update("notebook", &base).expect("carol replica");

        let mut alice_note = alice.snapshot().expect("alice projection").notes[0].clone();
        alice_note.content = "alice content".to_owned();
        alice_note.updated_at = 2;
        alice.upsert_note(&alice_note).expect("alice edit");
        let mut bob_note = bob.snapshot().expect("bob projection").notes[0].clone();
        bob_note.title = "Bob title".to_owned();
        bob_note.updated_at = 3;
        bob.upsert_note(&bob_note).expect("bob edit");
        carol
            .upsert_note(&Note {
                id: "carol-note".to_owned(),
                title: "Carol note".to_owned(),
                content: "carol content".to_owned(),
                folder_id: None,
                created_at: 4,
                updated_at: 4,
                deleted: false,
                deleted_at: None,
            })
            .expect("carol edit");

        alice_sync
            .request_sync(&alice, 10)
            .await
            .expect("broadcast request");
        let request = alice_transport
            .history("group", 1)
            .await
            .expect("request history")
            .pop()
            .expect("request message");
        bob_sync
            .process_transport_message(&bob, request.clone(), true)
            .await
            .expect("bob response");
        carol_sync
            .process_transport_message(&carol, request, true)
            .await
            .expect("carol response");

        let responses = alice_transport
            .history("group", 2)
            .await
            .expect("peer responses");
        for response in responses {
            alice_sync
                .process_transport_message(&alice, response, true)
                .await
                .expect("alice applies and fans out a response");
        }

        let fanout = alice_transport
            .history("group", 4)
            .await
            .expect("reverse deltas and relays");
        for message in fanout {
            bob_sync
                .process_transport_message(&bob, message.clone(), true)
                .await
                .expect("bob applies fanout");
            carol_sync
                .process_transport_message(&carol, message, true)
                .await
                .expect("carol applies fanout");
        }

        assert_eq!(
            alice.snapshot().expect("alice final"),
            bob.snapshot().expect("bob final")
        );
        assert_eq!(
            alice.snapshot().expect("alice final"),
            carol.snapshot().expect("carol final")
        );
    }

    #[tokio::test]
    async fn malformed_history_is_quarantined_without_blocking_later_state() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "notebook");
        let alice_transport = Arc::new(broker.endpoint("alice-inbox"));
        let bob_transport = Arc::new(broker.endpoint("bob-inbox"));
        let alice_sync = SyncEngine::new(Arc::clone(&alice_transport), "notebook", "group");
        let bob_sync = SyncEngine::new(bob_transport, "notebook", "group");
        let alice = NotebookCrdt::new("notebook").expect("alice replica");
        let bob = NotebookCrdt::new("notebook").expect("bob replica");
        seed(&alice);

        alice_transport
            .send_text("group", format!("{PROTOCOL_PREFIX}{{not-json"))
            .await
            .expect("send malformed protocol text");
        alice_sync
            .publish_snapshot(&alice, 2)
            .await
            .expect("publish valid state after malformed message");
        bob_sync
            .pull_history(&bob)
            .await
            .expect("history continues after quarantine");

        assert_eq!(
            alice.snapshot().expect("alice projection"),
            bob.snapshot().expect("bob projection")
        );
        let quarantine = bob_sync.quarantined_messages().expect("quarantine status");
        assert_eq!(quarantine.len(), 1);
        assert!(quarantine[0].error.contains("invalid JSON"));
    }

    #[tokio::test]
    async fn roundtrip_timeout_is_absolute_under_unrelated_traffic() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "notebook");
        let transport = Arc::new(broker.endpoint("requester-inbox"));
        let noise = broker.endpoint("noise-inbox");
        let engine = SyncEngine::new(Arc::clone(&transport), "notebook", "group");
        let replica = NotebookCrdt::new("notebook").expect("replica");
        seed(&replica);
        let spammer = tokio::spawn(async move {
            loop {
                noise
                    .send_text("group", "unrelated XMTP text".to_owned())
                    .await
                    .expect("send noise");
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            engine.sync_roundtrip(&replica, 1, std::time::Duration::from_millis(40)),
        )
        .await
        .expect("absolute deadline must not be extended by traffic");
        spammer.abort();
        assert!(matches!(result, Err(SyncError::Timeout)));
    }

    #[tokio::test]
    async fn history_replay_never_answers_stale_sync_requests() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "notebook");
        let alice_transport = Arc::new(broker.endpoint("alice-inbox"));
        let bob_transport = Arc::new(broker.endpoint("bob-inbox"));
        let alice_sync = SyncEngine::new(Arc::clone(&alice_transport), "notebook", "group");
        let bob_sync = SyncEngine::new(bob_transport, "notebook", "group");
        let left = NotebookCrdt::new("notebook").expect("left replica");
        let right = NotebookCrdt::new("notebook").expect("right replica");
        seed(&left);
        seed(&right);
        bob_sync
            .request_sync(&right, 10)
            .await
            .expect("send stale request");
        let before = alice_transport
            .history("group", usize::MAX)
            .await
            .expect("before history")
            .len();
        alice_sync
            .pull_history(&left)
            .await
            .expect("replay history");
        let after = alice_transport
            .history("group", usize::MAX)
            .await
            .expect("after history")
            .len();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn validates_notebook_group_binding_before_catch_up() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "different-notebook");
        let engine = SyncEngine::new(Arc::new(broker.endpoint("inbox")), "notebook", "group");
        let replica = NotebookCrdt::new("notebook").expect("replica");
        assert!(matches!(
            engine.announce_catch_up(&replica, 1).await,
            Err(SyncError::InvalidBinding(_))
        ));
    }

    #[tokio::test]
    async fn message_and_request_tracking_are_bounded() {
        let broker = MemoryBroker::default();
        broker.create_group("group", "notebook");
        let engine = SyncEngine::new(Arc::new(broker.endpoint("inbox")), "notebook", "group");
        let replica = NotebookCrdt::new("notebook").expect("replica");
        for index in 0..(MAX_OWN_MESSAGE_IDS + 8) {
            engine
                .publish_update(vec![0, 0], index as u64)
                .await
                .expect("publish update");
        }
        for index in 0..(MAX_ACTIVE_REQUEST_IDS + 8) {
            engine
                .request_sync(&replica, index as u64)
                .await
                .expect("request sync");
        }
        assert!(engine.own_message_ids.lock().expect("own IDs").ids.len() <= MAX_OWN_MESSAGE_IDS);
        assert!(
            engine.active_request_ids.lock().expect("request IDs").len() <= MAX_ACTIVE_REQUEST_IDS
        );
    }

    #[test]
    fn discovers_only_bound_notebook_groups() {
        let groups = vec![
            NotebookGroup {
                id: "b".to_owned(),
                description: "ordinary XMTP group".to_owned(),
            },
            NotebookGroup {
                id: "a".to_owned(),
                description: format!("{GROUP_DESCRIPTION_PREFIX}notes%2Fwork"),
            },
        ];
        assert_eq!(discover_notebooks(&groups)[0].0, "notes/work");
    }

    #[test]
    fn rejects_malformed_percent_encoding_and_non_utf8_ids() {
        for description in [
            format!("{GROUP_DESCRIPTION_PREFIX}bad%"),
            format!("{GROUP_DESCRIPTION_PREFIX}bad%GG"),
            format!("{GROUP_DESCRIPTION_PREFIX}%FF"),
        ] {
            assert!(NotebookGroup {
                id: "group".to_owned(),
                description,
            }
            .notebook_id()
            .is_none());
        }
    }
}
