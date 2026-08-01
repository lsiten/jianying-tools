//! Tauri-native capabilities for reliable mobile material transfer.

#![forbid(unsafe_code)]

use tauri::Manager as _;

/// Native WebSocket ownership for one mobile signaling session per transfer.
pub mod mobile_signaling;
/// Tauri command boundary for session binding and terminal signaling delivery.
pub mod mobile_transfer_commands;
/// Routes authenticated signaling control messages into durable native upload state.
pub mod transfer_control;
#[cfg(test)]
mod transfer_control_tests;
/// Durable native queue metadata and state transitions.
pub mod upload_queue;

/// Starts the Tauri shell without moving material-file bytes through frontend IPC.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = run_inner() {
        tracing::error!(error = %error, "mobile shell failed to start");
    }
}

#[allow(
    clippy::exit,
    reason = "tauri::generate_context! expands framework startup code that may terminate on fatal configuration failure"
)]
fn run_inner() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let queue_path = app.path().app_data_dir()?.join("upload-queue.json");
            app.manage(upload_queue::UploadQueue::open(queue_path)?);
            app.manage(transfer_control::TransferControl::new());
            app.manage(mobile_signaling::MobileSignaling::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_transfer_commands::bind_transfer_session,
            mobile_transfer_commands::consume_signaling_close,
            mobile_signaling::start_mobile_signaling,
            mobile_signaling::send_mobile_signaling_message,
        ])
        .run(tauri::generate_context!())
}
