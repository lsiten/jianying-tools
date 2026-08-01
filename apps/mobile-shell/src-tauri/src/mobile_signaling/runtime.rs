use futures_util::{SinkExt as _, StreamExt as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Manager as _, Runtime};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use super::{
    MobileSignaling, MobileSignalingCommandError,
    protocol::{SignalingMessageType, parse_header},
};
use crate::{
    transfer_control::{TransferCloseOutcome, TransferControl, TransferSessionId},
    upload_queue::UploadQueue,
};

/// Event carrying a non-terminal Worker message for the mobile WebRTC peer.
const MOBILE_SIGNALING_MESSAGE_EVENT: &str = "mobile-signaling-message";
/// Event carrying a terminal native queue outcome.
const MOBILE_SIGNALING_TERMINATED_EVENT: &str = "mobile-signaling-terminated";
/// Event carrying a transport error without exposing a credential or media payload.
const MOBILE_SIGNALING_ERROR_EVENT: &str = "mobile-signaling-error";

pub(super) async fn run_connection<R: Runtime>(
    app_handle: AppHandle<R>,
    registry: MobileSignaling,
    session_id: TransferSessionId,
    endpoint: Url,
    ready_sender: oneshot::Sender<Result<(), MobileSignalingCommandError>>,
) {
    let connection = connect_async(endpoint.as_str()).await;
    let Ok((stream, _)) = connection else {
        let _ = ready_sender.send(Err(MobileSignalingCommandError::ConnectionUnavailable));
        return;
    };
    let (sender, mut receiver) = mpsc::channel(32);
    if let Err(error) = registry.register(session_id.clone(), sender) {
        let _ = ready_sender.send(Err(error));
        return;
    }
    if ready_sender.send(Ok(())).is_err() {
        registry.remove(&session_id);
        return;
    }
    let (mut writer, mut reader) = stream.split();
    loop {
        tokio::select! {
            outbound = receiver.recv() => match outbound {
                Some(message) => {
                    if writer.send(Message::Text(message.into())).await.is_err() {
                        emit_error(&app_handle, &session_id, MobileSignalingCommandError::ConnectionUnavailable);
                        break;
                    }
                }
                None => break,
            },
            inbound = reader.next() => match inbound {
                Some(Ok(Message::Text(message))) => match handle_inbound(&app_handle, &session_id, message.as_str()) {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        emit_error(&app_handle, &session_id, error);
                        break;
                    }
                },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_) | Err(_)) => {
                    emit_error(&app_handle, &session_id, MobileSignalingCommandError::ConnectionUnavailable);
                    break;
                }
            },
        }
    }
    registry.remove(&session_id);
}

pub(super) fn handle_inbound<R: Runtime>(
    app_handle: &AppHandle<R>,
    expected_session_id: &TransferSessionId,
    message: &str,
) -> Result<bool, MobileSignalingCommandError> {
    let header = parse_header(message)?;
    if header.session_id != *expected_session_id {
        return Err(MobileSignalingCommandError::ConnectionUnavailable);
    }
    match header.message_type {
        SignalingMessageType::Close => {
            let outcome = app_handle
                .state::<TransferControl>()
                .consume_close_json(&app_handle.state::<UploadQueue>(), message)
                .map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)?;
            app_handle
                .emit(
                    MOBILE_SIGNALING_TERMINATED_EVENT,
                    TerminalSignalingEvent {
                        outcome,
                        session_id: expected_session_id,
                    },
                )
                .map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)?;
            Ok(false)
        }
        SignalingMessageType::Candidate | SignalingMessageType::Description => {
            app_handle
                .emit(
                    MOBILE_SIGNALING_MESSAGE_EVENT,
                    PeerSignalingEvent {
                        message,
                        session_id: expected_session_id,
                    },
                )
                .map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)?;
            Ok(true)
        }
    }
}

fn emit_error<R: Runtime>(
    app_handle: &AppHandle<R>,
    session_id: &TransferSessionId,
    error: MobileSignalingCommandError,
) {
    if app_handle
        .emit(
            MOBILE_SIGNALING_ERROR_EVENT,
            SignalingErrorEvent { error, session_id },
        )
        .is_err()
    {
        tracing::error!(
            session_id = session_id.as_str(),
            "failed to emit mobile signaling error"
        );
    }
}

#[derive(Clone, Serialize)]
struct PeerSignalingEvent<'a> {
    message: &'a str,
    session_id: &'a TransferSessionId,
}

#[derive(Clone, Serialize)]
struct TerminalSignalingEvent<'a> {
    outcome: TransferCloseOutcome,
    session_id: &'a TransferSessionId,
}

#[derive(Clone, Serialize)]
struct SignalingErrorEvent<'a> {
    error: MobileSignalingCommandError,
    session_id: &'a TransferSessionId,
}
