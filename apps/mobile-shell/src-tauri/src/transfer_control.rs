use std::{
    collections::BTreeMap,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Deserializer, Serialize};

use crate::upload_queue::{
    UploadId, UploadPauseReason, UploadQueue, UploadQueueError, UploadQueueStatus,
};

const UUID_HYPHEN_POSITIONS: [usize; 4] = [8, 13, 18, 23];

/// A WebRTC session identity that is valid for exactly one mobile upload attempt.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct TransferSessionId(String);

impl TransferSessionId {
    /// Parses the UUID-shaped session identity issued by the local server.
    pub fn parse(value: &str) -> Result<Self, TransferControlError> {
        let is_valid = value.len() == 36
            && value.bytes().enumerate().all(|(index, byte)| {
                if UUID_HYPHEN_POSITIONS.contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            });
        if !is_valid {
            return Err(TransferControlError::InvalidSessionId);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    /// Returns the stable protocol form used as the signaling session key.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for TransferSessionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// A one-to-one binding between an active signaling session and one queued material upload.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct TransferBinding {
    /// Server-issued signaling identity.
    pub session_id: TransferSessionId,
    /// The local item affected by a terminal signal for this session.
    pub upload_id: UploadId,
}

/// The externally visible result of routing a validated terminal signaling message.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
#[non_exhaustive]
pub enum TransferCloseOutcome {
    /// WebRTC connectivity failed after using the available ICE candidates.
    ConnectionFailed {
        /// Queue entry paused until the user retries from a usable network.
        upload_id: UploadId,
    },
    /// The Mac cancelled this transfer; the local item cannot resume silently.
    TransferCancelled {
        /// Queue entry that the remote Mac explicitly cancelled.
        upload_id: UploadId,
    },
    /// The Mac completed its protocol session; durable material completion remains ACK-driven.
    TransferFinished {
        /// Queue entry whose signaling session ended after the remote completion announcement.
        upload_id: UploadId,
    },
    /// A stale or unrelated Worker message had no local queue effect.
    UnboundSession {
        /// Session that did not own any active native queue entry.
        session_id: TransferSessionId,
    },
}

/// Failures while binding a session or consuming a Worker terminal control message.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum TransferControlError {
    /// The control frame did not satisfy the shared signaling close-message schema.
    #[error(transparent)]
    InvalidControlMessage(#[from] serde_json::Error),
    /// The server supplied an invalid WebRTC session identity.
    #[error("transfer session identity must be a UUID")]
    InvalidSessionId,
    /// Concurrent native control state could not be safely accessed.
    #[error("native transfer-control lock is poisoned")]
    LockPoisoned,
    /// The session was already paired with a different local upload.
    #[error("session {session_id} is already bound to upload {existing_upload_id}")]
    SessionAlreadyBound {
        /// Session whose one-to-one ownership was violated.
        session_id: String,
        /// Existing upload that remains authoritative.
        existing_upload_id: String,
    },
    /// Queue persistence or transition validation rejected the terminal state update.
    #[error(transparent)]
    UploadQueue(#[from] UploadQueueError),
}

/// Owns active session bindings without imposing a product cardinality limit.
#[derive(Debug)]
pub struct TransferControl {
    bindings: Mutex<BTreeMap<TransferSessionId, UploadId>>,
}

impl TransferControl {
    /// Creates an empty transfer-control registry.
    pub const fn new() -> Self {
        Self {
            bindings: Mutex::new(BTreeMap::new()),
        }
    }

    /// Registers an idempotent one-to-one session binding before native transfer work starts.
    pub fn bind(&self, binding: TransferBinding) -> Result<(), TransferControlError> {
        let mut bindings = self.lock()?;
        match bindings.get(&binding.session_id) {
            Some(existing_upload_id) if existing_upload_id != &binding.upload_id => {
                let error = TransferControlError::SessionAlreadyBound {
                    session_id: binding.session_id.as_str().to_owned(),
                    existing_upload_id: existing_upload_id.as_str().to_owned(),
                };
                drop(bindings);
                Err(error)
            }
            Some(_) => {
                drop(bindings);
                Ok(())
            }
            None => {
                bindings.insert(binding.session_id, binding.upload_id);
                drop(bindings);
                Ok(())
            }
        }
    }

    /// Parses a terminal Worker message and applies its state change only to its bound upload.
    pub fn consume_close_json(
        &self,
        queue: &UploadQueue,
        message: &str,
    ) -> Result<TransferCloseOutcome, TransferControlError> {
        let close: SignalingCloseMessage = serde_json::from_str(message)?;
        let Some(upload_id) = self.bound_upload(&close.session_id)? else {
            return Ok(TransferCloseOutcome::UnboundSession {
                session_id: close.session_id,
            });
        };

        let outcome = match close.reason {
            SignalingCloseReason::ConnectionFailed => {
                queue.set_status(
                    &upload_id,
                    UploadQueueStatus::Paused {
                        reason: UploadPauseReason::NetworkUnavailable,
                    },
                )?;
                TransferCloseOutcome::ConnectionFailed { upload_id }
            }
            SignalingCloseReason::TransferCancelled => {
                queue.set_status(&upload_id, UploadQueueStatus::Cancelled)?;
                TransferCloseOutcome::TransferCancelled { upload_id }
            }
            SignalingCloseReason::TransferFinished => {
                TransferCloseOutcome::TransferFinished { upload_id }
            }
        };
        self.unbind(&close.session_id)?;
        Ok(outcome)
    }

    fn bound_upload(
        &self,
        session_id: &TransferSessionId,
    ) -> Result<Option<UploadId>, TransferControlError> {
        Ok(self.lock()?.get(session_id).cloned())
    }

    fn lock(
        &self,
    ) -> Result<MutexGuard<'_, BTreeMap<TransferSessionId, UploadId>>, TransferControlError> {
        self.bindings
            .lock()
            .map_err(|_| TransferControlError::LockPoisoned)
    }

    fn unbind(&self, session_id: &TransferSessionId) -> Result<(), TransferControlError> {
        self.lock()?.remove(session_id);
        Ok(())
    }
}

impl Default for TransferControl {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SignalingCloseReason {
    ConnectionFailed,
    TransferCancelled,
    TransferFinished,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalingCloseMessage {
    reason: SignalingCloseReason,
    #[serde(rename = "sessionId")]
    session_id: TransferSessionId,
    #[serde(rename = "type")]
    _message_type: SignalingCloseType,
}

#[derive(Deserialize)]
enum SignalingCloseType {
    #[serde(rename = "close")]
    Close,
}
