use serde::Serialize;
use tauri::State;

use crate::{
    transfer_control::{
        TransferBinding, TransferCloseOutcome, TransferControl, TransferControlError,
        TransferSessionId,
    },
    upload_queue::{UploadId, UploadQueue, UploadQueueError},
};

/// A stable command error that the mobile `WebView` can render without receiving native internals.
#[derive(Debug, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", tag = "code")]
#[non_exhaustive]
pub enum MobileTransferCommandError {
    /// The worker close frame did not match the shared signaling contract.
    InvalidControlMessage,
    /// The session identity was not a UUID accepted by the local server contract.
    InvalidSessionId,
    /// The invoking `WebView` supplied an empty upload identifier.
    InvalidUploadId,
    /// The session was already bound to another local upload.
    SessionAlreadyBound,
    /// Queue state disallowed the requested terminal transition.
    QueueStateInvalid,
    /// Queue metadata could not be persisted or recovered safely.
    QueueUnavailable,
    /// Queue data belongs to a newer native shell version.
    QueueSchemaUnsupported,
}

/// Binds one active Worker session to the queued upload that it is permitted to control.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command parameters must own deserialized IPC values and State handles"
)]
pub fn bind_transfer_session(
    session_id: String,
    upload_id: String,
    transfer_control: State<'_, TransferControl>,
) -> Result<(), MobileTransferCommandError> {
    transfer_control
        .bind(parse_transfer_binding(&session_id, &upload_id)?)
        .map_err(Into::into)
}

/// Persists an authenticated Worker terminal frame without exposing a material byte to `WebView` IPC.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command parameters must own deserialized IPC values and State handles"
)]
pub fn consume_signaling_close(
    message: String,
    upload_queue: State<'_, UploadQueue>,
    transfer_control: State<'_, TransferControl>,
) -> Result<TransferCloseOutcome, MobileTransferCommandError> {
    transfer_control
        .consume_close_json(&upload_queue, &message)
        .map_err(Into::into)
}

fn parse_transfer_binding(
    session_id: &str,
    upload_id: &str,
) -> Result<TransferBinding, MobileTransferCommandError> {
    Ok(TransferBinding {
        session_id: TransferSessionId::parse(session_id)?,
        upload_id: UploadId::parse(upload_id).map_err(|error| match error {
            UploadQueueError::InvalidUploadId => MobileTransferCommandError::InvalidUploadId,
            UploadQueueError::InvalidDecimalCounter
            | UploadQueueError::DuplicateUpload(_)
            | UploadQueueError::LockPoisoned
            | UploadQueueError::UploadNotFound(_)
            | UploadQueueError::UploadInitialStateInvalid(_)
            | UploadQueueError::UploadStateInvalid(_)
            | UploadQueueError::UnsupportedSchemaVersion(_)
            | UploadQueueError::Io(_)
            | UploadQueueError::Json(_) => MobileTransferCommandError::QueueUnavailable,
        })?,
    })
}

impl From<TransferControlError> for MobileTransferCommandError {
    fn from(error: TransferControlError) -> Self {
        match error {
            TransferControlError::InvalidControlMessage(_) => Self::InvalidControlMessage,
            TransferControlError::InvalidSessionId => Self::InvalidSessionId,
            TransferControlError::LockPoisoned => Self::QueueUnavailable,
            TransferControlError::SessionAlreadyBound { .. } => Self::SessionAlreadyBound,
            TransferControlError::UploadQueue(queue_error) => Self::from(queue_error),
        }
    }
}

impl From<UploadQueueError> for MobileTransferCommandError {
    fn from(error: UploadQueueError) -> Self {
        match error {
            UploadQueueError::DuplicateUpload(_)
            | UploadQueueError::UploadInitialStateInvalid(_)
            | UploadQueueError::UploadStateInvalid(_)
            | UploadQueueError::UploadNotFound(_) => Self::QueueStateInvalid,
            UploadQueueError::InvalidUploadId => Self::InvalidUploadId,
            UploadQueueError::InvalidDecimalCounter
            | UploadQueueError::LockPoisoned
            | UploadQueueError::Io(_)
            | UploadQueueError::Json(_) => Self::QueueUnavailable,
            UploadQueueError::UnsupportedSchemaVersion(_) => Self::QueueSchemaUnsupported,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_transfer_binding;

    #[test]
    fn rejects_an_empty_upload_id_at_the_tauri_command_boundary() {
        // Given: an untrusted invocation payload from the mobile webview.

        // When: it attempts to bind an empty upload identity.
        let parsed = parse_transfer_binding("00000000-0000-4000-8000-000000000001", "");

        // Then: it fails before native queue or session state changes.
        assert!(parsed.is_err());
    }
}
