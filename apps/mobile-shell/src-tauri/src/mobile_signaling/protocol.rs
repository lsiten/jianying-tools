use serde::Deserialize;
use url::Url;

use super::MobileSignalingCommandError;
use crate::transfer_control::TransferSessionId;

pub(super) fn create_signaling_url(
    worker_base_url: &str,
    session_id: &TransferSessionId,
    token: &str,
) -> Result<Url, MobileSignalingCommandError> {
    let mut endpoint =
        Url::parse(worker_base_url).map_err(|_| MobileSignalingCommandError::WorkerUrlInvalid)?;
    match endpoint.scheme() {
        "https" => endpoint
            .set_scheme("wss")
            .map_err(|()| MobileSignalingCommandError::WorkerUrlInvalid)?,
        "http" => endpoint
            .set_scheme("ws")
            .map_err(|()| MobileSignalingCommandError::WorkerUrlInvalid)?,
        "wss" | "ws" => {}
        _ => return Err(MobileSignalingCommandError::WorkerUrlInvalid),
    }
    endpoint.set_path(&format!(
        "{}/v1/signal/{}",
        endpoint.path().trim_end_matches('/'),
        session_id.as_str()
    ));
    endpoint.set_query(None);
    endpoint.query_pairs_mut().append_pair("token", token);
    Ok(endpoint)
}

pub(super) fn parse_header(message: &str) -> Result<SignalingHeader, MobileSignalingCommandError> {
    serde_json::from_str(message).map_err(|_| MobileSignalingCommandError::ConnectionUnavailable)
}

pub(super) fn validate_session_message(
    message: &str,
    session_id: &TransferSessionId,
) -> Result<(), MobileSignalingCommandError> {
    if parse_header(message)?.session_id == *session_id {
        Ok(())
    } else {
        Err(MobileSignalingCommandError::ConnectionUnavailable)
    }
}

#[derive(Deserialize)]
pub(super) struct SignalingHeader {
    #[serde(rename = "sessionId")]
    pub(super) session_id: TransferSessionId,
    #[serde(rename = "type")]
    pub(super) message_type: SignalingMessageType,
}

#[derive(Deserialize)]
pub(super) enum SignalingMessageType {
    #[serde(rename = "candidate")]
    Candidate,
    #[serde(rename = "close")]
    Close,
    #[serde(rename = "description")]
    Description,
}
