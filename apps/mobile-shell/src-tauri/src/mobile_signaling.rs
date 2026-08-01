#![allow(
    clippy::unreachable,
    reason = "Tauri generates unreachable return-type checking glue for async commands"
)]

mod protocol;
mod runtime;
#[cfg(test)]
mod tests;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::{mpsc, oneshot};

use crate::transfer_control::TransferSessionId;

use self::{
    protocol::{create_signaling_url, validate_session_message},
    runtime::run_connection,
};

/// A command-safe signaling failure code for the mobile `WebView`.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", tag = "code")]
#[non_exhaustive]
pub enum MobileSignalingCommandError {
    /// No active native socket owns the requested session.
    #[error("native signaling connection is unavailable")]
    ConnectionUnavailable,
    /// A connection already owns the requested mobile signaling session.
    #[error("native signaling session is already connected")]
    SessionAlreadyConnected,
    /// The caller supplied an empty short-lived Worker token.
    #[error("mobile signaling token is missing")]
    TokenMissing,
    /// The supplied Worker base URL cannot form a direct WSS endpoint.
    #[error("mobile signaling Worker URL is invalid")]
    WorkerUrlInvalid,
}

/// Owns independent signaling connections without imposing a product cardinality limit.
#[derive(Clone, Debug)]
pub struct MobileSignaling {
    senders: Arc<Mutex<BTreeMap<TransferSessionId, mpsc::Sender<String>>>>,
}

impl MobileSignaling {
    /// Creates an empty native signaling registry.
    pub fn new() -> Self {
        Self {
            senders: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn register(
        &self,
        session_id: TransferSessionId,
        sender: mpsc::Sender<String>,
    ) -> Result<(), MobileSignalingCommandError> {
        let mut senders = self
            .senders
            .lock()
            .map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)?;
        if senders.contains_key(&session_id) {
            drop(senders);
            return Err(MobileSignalingCommandError::SessionAlreadyConnected);
        }
        senders.insert(session_id, sender);
        drop(senders);
        Ok(())
    }

    fn sender(
        &self,
        session_id: &TransferSessionId,
    ) -> Result<mpsc::Sender<String>, MobileSignalingCommandError> {
        self.senders
            .lock()
            .map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)?
            .get(session_id)
            .cloned()
            .ok_or(MobileSignalingCommandError::ConnectionUnavailable)
    }

    fn remove(&self, session_id: &TransferSessionId) {
        if let Ok(mut senders) = self.senders.lock() {
            senders.remove(session_id);
        }
    }
}

impl Default for MobileSignaling {
    fn default() -> Self {
        Self::new()
    }
}

/// Opens the sole mobile-role WSS connection for a session and returns after its handshake succeeds.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command parameters must own deserialized IPC values and State handles"
)]
pub async fn start_mobile_signaling(
    session_id: String,
    token: String,
    worker_base_url: String,
    app_handle: AppHandle,
    mobile_signaling: State<'_, MobileSignaling>,
) -> Result<(), MobileSignalingCommandError> {
    if token.trim().is_empty() {
        return Err(MobileSignalingCommandError::TokenMissing);
    }
    let session_id = TransferSessionId::parse(&session_id)
        .map_err(|_| MobileSignalingCommandError::WorkerUrlInvalid)?;
    let endpoint = create_signaling_url(&worker_base_url, &session_id, &token)?;
    let (ready_sender, ready_receiver) = oneshot::channel();
    tauri::async_runtime::spawn(run_connection(
        app_handle,
        (*mobile_signaling).clone(),
        session_id,
        endpoint,
        ready_sender,
    ));
    ready_receiver
        .await
        .map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)?
}

/// Delivers validated non-media WebRTC signaling through the native session owner.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command parameters must own deserialized IPC values and State handles"
)]
pub async fn send_mobile_signaling_message(
    session_id: String,
    message: String,
    mobile_signaling: State<'_, MobileSignaling>,
) -> Result<(), MobileSignalingCommandError> {
    let session_id = TransferSessionId::parse(&session_id)
        .map_err(|_| MobileSignalingCommandError::WorkerUrlInvalid)?;
    validate_session_message(&message, &session_id)?;
    mobile_signaling
        .sender(&session_id)?
        .send(message)
        .await
        .map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)
}
