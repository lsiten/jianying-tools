use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Write as _,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Deserializer, Serialize};

const QUEUE_SCHEMA_VERSION: u8 = 1;

/// A server-assigned upload identifier that cannot be empty.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct UploadId(String);

impl UploadId {
    /// Validates an upload identifier received from the local server.
    pub fn parse(value: &str) -> Result<Self, UploadQueueError> {
        if value.trim().is_empty() {
            return Err(UploadQueueError::InvalidUploadId);
        }
        Ok(Self(value.to_owned()))
    }

    /// Returns the string representation needed by the shared transfer protocol.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for UploadId {
    type Error = UploadQueueError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl<'de> Deserialize<'de> for UploadId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// An exact non-negative decimal counter kept as text to avoid artificial native integer limits.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DecimalCounter(String);

impl DecimalCounter {
    /// Parses an unsigned decimal count such as a byte offset or acknowledgement epoch.
    pub fn parse(value: &str) -> Result<Self, UploadQueueError> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(UploadQueueError::InvalidDecimalCounter);
        }
        Ok(Self(value.to_owned()))
    }

    /// Returns the protocol representation without converting through a bounded integer.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for DecimalCounter {
    type Error = UploadQueueError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl<'de> Deserialize<'de> for DecimalCounter {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// A native file identity recorded before the queue reads any material bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct SourceFileFingerprint {
    /// Source file byte length at queue admission.
    pub byte_length: u64,
    /// SHA-256 of the source file calculated by native code.
    pub sha256: String,
}

/// A server-authorized material transfer that remains native until it reaches WebRTC.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct UploadQueueEntry {
    /// Server-issued upload identity.
    pub upload_id: UploadId,
    /// Native-only path after the media picker has obtained scoped access or copied a source safely.
    pub source_path: PathBuf,
    /// Identity used to detect a changed mobile source before resume.
    pub fingerprint: SourceFileFingerprint,
    /// The last durable acknowledgement returned by the Mac server.
    pub progress: UploadProgress,
    /// Runtime state retained across backgrounding and process restarts.
    pub status: UploadQueueStatus,
}

/// Progress values are stored as decimal strings so queue metadata never imposes a file-size limit.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct UploadProgress {
    /// Last persisted server acknowledgement epoch.
    pub ack_epoch: DecimalCounter,
    /// Number of bytes durably accepted by the Mac server.
    pub received_bytes: DecimalCounter,
    /// Next 64-bit protocol chunk number represented without native narrowing.
    pub next_chunk_index: DecimalCounter,
}

/// A machine-readable condition that pauses an otherwise resumable mobile transfer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[non_exhaustive]
pub enum UploadPauseReason {
    /// Native background execution ended before the current transfer completed.
    BackgroundExecutionStopped,
    /// The Mac server is not reachable through the signaling service.
    MacOffline,
    /// The source device temporarily has no usable network path.
    NetworkUnavailable,
    /// The local Mac storage write was interrupted before an acknowledgement.
    IoInterrupted,
    /// The Node storage implementation cannot address the requested valid protocol offset.
    StoragePositionUnsupported,
    /// The user explicitly paused the queue entry.
    UserRequested,
}

/// Durable queue states; the native sender may only stream when the state is `Transferring`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
#[non_exhaustive]
pub enum UploadQueueStatus {
    /// A file has been selected but no WebRTC session is active.
    Pending,
    /// Native file reads may proceed directly into bounded `DataChannel` frames.
    Transferring,
    /// The user or operating system paused transfer work; no bytes may be emitted.
    Paused {
        /// Typed condition that explains why native byte reads must remain stopped.
        reason: UploadPauseReason,
    },
    /// The source was cancelled locally and cannot be silently resumed.
    Cancelled,
    /// The server returned a final material identifier after hash verification and commit.
    Completed {
        /// Final material identity returned only after the Mac completed its durable commit.
        material_id: String,
    },
}

/// Errors surfaced by queue persistence and legal state transitions.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum UploadQueueError {
    /// The same server upload is already represented in the local queue.
    #[error("upload {0} is already present in the native queue")]
    DuplicateUpload(String),
    /// A counter is not an unsigned decimal protocol value.
    #[error("queue counter must be a non-empty unsigned decimal")]
    InvalidDecimalCounter,
    /// An upload identity is empty.
    #[error("upload identity cannot be empty")]
    InvalidUploadId,
    /// The queue cannot be locked because an earlier panic poisoned the state.
    #[error("native upload queue lock is poisoned")]
    LockPoisoned,
    /// The requested entry does not exist.
    #[error("upload {0} was not found in the native queue")]
    UploadNotFound(String),
    /// A newly enqueued item skipped the required `Pending` state.
    #[error("upload {0} must enter the native queue as pending")]
    UploadInitialStateInvalid(String),
    /// The requested operation is illegal for the persisted state.
    #[error("upload {0} cannot accept this operation in its current state")]
    UploadStateInvalid(String),
    /// The file was created by a newer native queue implementation.
    #[error("queue schema version {0} is not supported")]
    UnsupportedSchemaVersion(u8),
    /// Local metadata persistence failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Persisted metadata did not match the queue schema.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// A synchronised, atomically persisted queue that stores only metadata, never material bytes.
#[derive(Debug)]
pub struct UploadQueue {
    path: PathBuf,
    state: Mutex<UploadQueueSnapshot>,
}

impl UploadQueue {
    /// Opens an existing native queue or creates a new empty one at the supplied app-data path.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, UploadQueueError> {
        let path = path.into();
        let state = load_snapshot(&path)?;
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    /// Adds a server-authorized item to the durable native queue.
    pub fn enqueue(&self, entry: UploadQueueEntry) -> Result<(), UploadQueueError> {
        self.mutate(|snapshot| {
            let upload_id = entry.upload_id.as_str().to_owned();
            if snapshot.entries.contains_key(&entry.upload_id) {
                return Err(UploadQueueError::DuplicateUpload(upload_id));
            }
            if entry.status != UploadQueueStatus::Pending {
                return Err(UploadQueueError::UploadInitialStateInvalid(upload_id));
            }
            snapshot.entries.insert(entry.upload_id.clone(), entry);
            Ok(())
        })
    }

    /// Records a server ACK only while the entry is actively transferring.
    pub fn record_ack(
        &self,
        upload_id: &UploadId,
        progress: UploadProgress,
    ) -> Result<(), UploadQueueError> {
        self.mutate(|snapshot| {
            let entry = snapshot.entry_mut(upload_id)?;
            if entry.status != UploadQueueStatus::Transferring {
                return Err(UploadQueueError::UploadStateInvalid(
                    upload_id.as_str().to_owned(),
                ));
            }
            entry.progress = progress;
            Ok(())
        })
    }

    /// Changes the state without exposing native file bytes to the frontend process.
    pub fn set_status(
        &self,
        upload_id: &UploadId,
        status: UploadQueueStatus,
    ) -> Result<(), UploadQueueError> {
        self.mutate(|snapshot| {
            let entry = snapshot.entry_mut(upload_id)?;
            if !entry.status.allows_transition_to(&status) {
                return Err(UploadQueueError::UploadStateInvalid(
                    upload_id.as_str().to_owned(),
                ));
            }
            entry.status = status;
            Ok(())
        })
    }

    /// Returns a copy of the small queue metadata snapshot for native upload orchestration.
    pub fn snapshot(&self) -> Result<UploadQueueSnapshot, UploadQueueError> {
        Ok(self.lock()?.clone())
    }

    fn lock(&self) -> Result<MutexGuard<'_, UploadQueueSnapshot>, UploadQueueError> {
        self.state
            .lock()
            .map_err(|_| UploadQueueError::LockPoisoned)
    }

    fn mutate(
        &self,
        mutation: impl FnOnce(&mut UploadQueueSnapshot) -> Result<(), UploadQueueError>,
    ) -> Result<(), UploadQueueError> {
        let mut state = self.lock()?;
        let prior = state.clone();
        if let Err(error) = mutation(&mut state) {
            *state = prior;
            drop(state);
            return Err(error);
        }
        if let Err(error) = persist_snapshot(&self.path, &state) {
            *state = prior;
            drop(state);
            return Err(error);
        }
        drop(state);
        Ok(())
    }
}

impl UploadQueueStatus {
    const fn allows_transition_to(&self, next: &Self) -> bool {
        match self {
            Self::Pending => matches!(
                next,
                Self::Pending | Self::Transferring | Self::Paused { .. } | Self::Cancelled
            ),
            Self::Transferring => matches!(
                next,
                Self::Transferring | Self::Paused { .. } | Self::Cancelled | Self::Completed { .. }
            ),
            Self::Paused { .. } => matches!(
                next,
                Self::Paused { .. } | Self::Transferring | Self::Cancelled
            ),
            Self::Cancelled => matches!(next, Self::Cancelled),
            Self::Completed { .. } => matches!(next, Self::Completed { .. }),
        }
    }
}

/// The full persisted queue document; this is control metadata only.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UploadQueueSnapshot {
    schema_version: u8,
    entries: BTreeMap<UploadId, UploadQueueEntry>,
}

impl UploadQueueSnapshot {
    /// Builds a zero-entry snapshot for a new application installation.
    pub const fn empty() -> Self {
        Self {
            schema_version: QUEUE_SCHEMA_VERSION,
            entries: BTreeMap::new(),
        }
    }

    /// Looks up one entry by its server-issued identity.
    pub fn entry(&self, upload_id: &UploadId) -> Option<&UploadQueueEntry> {
        self.entries.get(upload_id)
    }

    fn entry_mut(
        &mut self,
        upload_id: &UploadId,
    ) -> Result<&mut UploadQueueEntry, UploadQueueError> {
        self.entries
            .get_mut(upload_id)
            .ok_or_else(|| UploadQueueError::UploadNotFound(upload_id.as_str().to_owned()))
    }
}

fn load_snapshot(path: &Path) -> Result<UploadQueueSnapshot, UploadQueueError> {
    match fs::read(path) {
        Ok(bytes) => {
            let snapshot: UploadQueueSnapshot = serde_json::from_slice(&bytes)?;
            if snapshot.schema_version != QUEUE_SCHEMA_VERSION {
                return Err(UploadQueueError::UnsupportedSchemaVersion(
                    snapshot.schema_version,
                ));
            }
            Ok(snapshot)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(UploadQueueSnapshot::empty())
        }
        Err(error) => Err(UploadQueueError::Io(error)),
    }
}

fn persist_snapshot(path: &Path, snapshot: &UploadQueueSnapshot) -> Result<(), UploadQueueError> {
    let parent = path.parent().ok_or_else(|| {
        UploadQueueError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "queue metadata path has no parent directory",
        ))
    })?;
    fs::create_dir_all(parent)?;
    let temporary_path = path.with_extension("tmp");
    match fs::remove_file(&temporary_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(UploadQueueError::Io(error)),
    }
    let bytes = serde_json::to_vec(snapshot)?;
    let mut file = File::options()
        .create_new(true)
        .write(true)
        .open(&temporary_path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary_path, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        DecimalCounter, SourceFileFingerprint, UploadId, UploadPauseReason, UploadProgress,
        UploadQueue, UploadQueueEntry, UploadQueueStatus,
    };

    #[test]
    fn persists_acknowledgement_metadata_without_a_file_size_or_batch_limit()
    -> Result<(), super::UploadQueueError> {
        let directory = tempfile::tempdir()?;
        let queue_path = directory.path().join("upload-queue.json");
        let queue = UploadQueue::open(&queue_path)?;
        let upload_id = UploadId::parse("8e9eb53c-3e40-4ebd-b25e-a4bbeb3f5b4e")?;
        let original_progress = progress("0", "0", "0")?;
        queue.enqueue(UploadQueueEntry {
            upload_id: upload_id.clone(),
            source_path: directory.path().join("source.mov"),
            fingerprint: SourceFileFingerprint {
                byte_length: u64::MAX,
                sha256: "abc".to_owned(),
            },
            progress: original_progress,
            status: UploadQueueStatus::Pending,
        })?;
        queue.set_status(&upload_id, UploadQueueStatus::Transferring)?;

        queue.record_ack(
            &upload_id,
            progress(
                "18446744073709551616",
                "999999999999999999999999",
                "4294967296",
            )?,
        )?;
        drop(queue);

        let recovered_queue = UploadQueue::open(&queue_path)?;
        let recovered = recovered_queue.snapshot()?;
        let entry = recovered.entry(&upload_id).ok_or_else(|| {
            super::UploadQueueError::UploadNotFound(upload_id.as_str().to_owned())
        })?;
        assert_eq!(entry.progress.ack_epoch.as_str(), "18446744073709551616");
        assert_eq!(entry.progress.next_chunk_index.as_str(), "4294967296");
        Ok(())
    }

    #[test]
    fn retains_terminal_cancellation_when_a_stale_sender_attempts_to_resume()
    -> Result<(), super::UploadQueueError> {
        let directory = tempfile::tempdir()?;
        let queue = UploadQueue::open(directory.path().join("upload-queue.json"))?;
        let upload_id = UploadId::parse("4c6f7ba9-55d4-496b-9ec5-0230e919f7a9")?;
        queue.enqueue(UploadQueueEntry {
            upload_id: upload_id.clone(),
            source_path: directory.path().join("source.mov"),
            fingerprint: SourceFileFingerprint {
                byte_length: 5,
                sha256: "abc".to_owned(),
            },
            progress: progress("0", "0", "0")?,
            status: UploadQueueStatus::Pending,
        })?;
        queue.set_status(&upload_id, UploadQueueStatus::Cancelled)?;

        let resume = queue.set_status(&upload_id, UploadQueueStatus::Transferring);

        assert!(matches!(
            resume,
            Err(super::UploadQueueError::UploadStateInvalid(_))
        ));
        assert_eq!(
            queue
                .snapshot()?
                .entry(&upload_id)
                .map(|entry| &entry.status),
            Some(&UploadQueueStatus::Cancelled)
        );
        Ok(())
    }

    #[test]
    fn persists_network_pause_as_a_machine_readable_paused_state()
    -> Result<(), super::UploadQueueError> {
        let directory = tempfile::tempdir()?;
        let queue_path = directory.path().join("upload-queue.json");
        let queue = UploadQueue::open(&queue_path)?;
        let upload_id = UploadId::parse("eb2c1d8d-fd59-4d95-9d3b-6cc1cfa70c4b")?;
        queue.enqueue(UploadQueueEntry {
            upload_id: upload_id.clone(),
            source_path: directory.path().join("source.mov"),
            fingerprint: SourceFileFingerprint {
                byte_length: 5,
                sha256: "abc".to_owned(),
            },
            progress: progress("0", "0", "0")?,
            status: UploadQueueStatus::Pending,
        })?;
        queue.set_status(&upload_id, UploadQueueStatus::Transferring)?;

        queue.set_status(
            &upload_id,
            UploadQueueStatus::Paused {
                reason: UploadPauseReason::NetworkUnavailable,
            },
        )?;
        drop(queue);

        let recovered = UploadQueue::open(&queue_path)?.snapshot()?;
        assert_eq!(
            recovered.entry(&upload_id).map(|entry| &entry.status),
            Some(&UploadQueueStatus::Paused {
                reason: UploadPauseReason::NetworkUnavailable,
            })
        );
        Ok(())
    }

    #[test]
    fn retains_every_entry_in_a_large_batch_without_a_queue_cardinality_limit()
    -> Result<(), super::UploadQueueError> {
        let directory = tempfile::tempdir()?;
        let queue = UploadQueue::open(directory.path().join("upload-queue.json"))?;
        let batch_item_count = 1_024_u16;

        for index in 0..batch_item_count {
            let upload_id = UploadId::parse(&format!("batch-{index}"))?;
            queue.enqueue(UploadQueueEntry {
                upload_id,
                source_path: directory.path().join(format!("source-{index}.mov")),
                fingerprint: SourceFileFingerprint {
                    byte_length: 1,
                    sha256: "abc".to_owned(),
                },
                progress: progress("0", "0", "0")?,
                status: UploadQueueStatus::Pending,
            })?;
        }

        let snapshot = queue.snapshot()?;
        for index in 0..batch_item_count {
            let upload_id = UploadId::parse(&format!("batch-{index}"))?;
            assert!(snapshot.entry(&upload_id).is_some());
        }
        Ok(())
    }

    fn progress(
        ack_epoch: &str,
        received_bytes: &str,
        next_chunk_index: &str,
    ) -> Result<UploadProgress, super::UploadQueueError> {
        Ok(UploadProgress {
            ack_epoch: DecimalCounter::parse(ack_epoch)?,
            received_bytes: DecimalCounter::parse(received_bytes)?,
            next_chunk_index: DecimalCounter::parse(next_chunk_index)?,
        })
    }
}
