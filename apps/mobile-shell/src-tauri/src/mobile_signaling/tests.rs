use super::{protocol::create_signaling_url, runtime::handle_inbound};
use crate::{
    transfer_control::{TransferBinding, TransferControl, TransferSessionId},
    upload_queue::{
        DecimalCounter, SourceFileFingerprint, UploadId, UploadPauseReason, UploadProgress,
        UploadQueue, UploadQueueEntry, UploadQueueStatus,
    },
};

#[test]
fn converts_the_deployed_worker_http_base_to_a_session_scoped_wss_url()
-> Result<(), Box<dyn std::error::Error>> {
    // Given: a Worker base URL, server-issued mobile token, and one WebRTC session.
    let session_id = TransferSessionId::parse("00000000-0000-4000-8000-000000000001")?;

    // When: native signaling builds its connection endpoint.
    let endpoint = create_signaling_url(
        "https://signal.example.workers.dev",
        &session_id,
        "mobile-token",
    )?;

    // Then: it uses WSS and carries only the short-lived token query parameter.
    assert_eq!(
        endpoint.as_str(),
        "wss://signal.example.workers.dev/v1/signal/00000000-0000-4000-8000-000000000001?token=mobile-token"
    );
    Ok(())
}

#[test]
fn persists_a_worker_connection_failure_through_the_real_tauri_state_boundary()
-> Result<(), Box<dyn std::error::Error>> {
    // Given: an app handle owning an active native queue item and its session binding.
    let directory = tempfile::tempdir()?;
    let queue_path = directory.path().join("upload-queue.json");
    let queue = UploadQueue::open(&queue_path)?;
    let upload_id = UploadId::parse("connection-failure-target")?;
    queue.enqueue(UploadQueueEntry {
        upload_id: upload_id.clone(),
        source_path: directory.path().join("connection-failure-target.mov"),
        fingerprint: SourceFileFingerprint {
            byte_length: 1,
            sha256: "abc".to_owned(),
        },
        progress: UploadProgress {
            ack_epoch: DecimalCounter::parse("0")?,
            received_bytes: DecimalCounter::parse("0")?,
            next_chunk_index: DecimalCounter::parse("0")?,
        },
        status: UploadQueueStatus::Pending,
    })?;
    queue.set_status(&upload_id, UploadQueueStatus::Transferring)?;
    let transfer_control = TransferControl::new();
    let session_id = TransferSessionId::parse("00000000-0000-4000-8000-000000000003")?;
    transfer_control.bind(TransferBinding {
        session_id: session_id.clone(),
        upload_id: upload_id.clone(),
    })?;
    let app = tauri::test::mock_builder()
        .manage(queue)
        .manage(transfer_control)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))?;

    // When: the native WSS listener consumes the terminal Worker frame.
    let should_continue = handle_inbound(
        app.handle(),
        &session_id,
        r#"{"type":"close","sessionId":"00000000-0000-4000-8000-000000000003","reason":"CONNECTION_FAILED"}"#,
    )?;
    drop(app);

    // Then: it stops that connection and the durable queue retains the network pause.
    assert!(!should_continue);
    let recovered = UploadQueue::open(&queue_path)?.snapshot()?;
    assert!(matches!(
        recovered.entry(&upload_id).map(|entry| &entry.status),
        Some(UploadQueueStatus::Paused { .. })
    ));
    Ok(())
}

#[test]
fn persists_a_worker_direct_failure_through_the_real_tauri_state_boundary()
-> Result<(), Box<dyn std::error::Error>> {
    // Given: the exact same native boundary with an active transfer.
    let directory = tempfile::tempdir()?;
    let queue_path = directory.path().join("upload-queue.json");
    let queue = UploadQueue::open(&queue_path)?;
    let upload_id = UploadId::parse("direct-failure-target")?;
    queue.enqueue(UploadQueueEntry {
        upload_id: upload_id.clone(),
        source_path: directory.path().join("direct-failure-target.mov"),
        fingerprint: SourceFileFingerprint {
            byte_length: 1,
            sha256: "abc".to_owned(),
        },
        progress: UploadProgress {
            ack_epoch: DecimalCounter::parse("0")?,
            received_bytes: DecimalCounter::parse("0")?,
            next_chunk_index: DecimalCounter::parse("0")?,
        },
        status: UploadQueueStatus::Pending,
    })?;
    queue.set_status(&upload_id, UploadQueueStatus::Transferring)?;
    let transfer_control = TransferControl::new();
    let session_id = TransferSessionId::parse("00000000-0000-4000-8000-000000000004")?;
    transfer_control.bind(TransferBinding {
        session_id: session_id.clone(),
        upload_id: upload_id.clone(),
    })?;
    let app = tauri::test::mock_builder()
        .manage(queue)
        .manage(transfer_control)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))?;

    // When: the Worker reports an ordinary failed connection.
    let should_continue = handle_inbound(
        app.handle(),
        &session_id,
        r#"{"type":"close","sessionId":"00000000-0000-4000-8000-000000000004","reason":"CONNECTION_FAILED"}"#,
    )?;
    drop(app);

    // Then: it remains resumable as a network condition.
    assert!(!should_continue);
    let recovered = UploadQueue::open(&queue_path)?.snapshot()?;
    assert_eq!(
        recovered.entry(&upload_id).map(|entry| &entry.status),
        Some(&UploadQueueStatus::Paused {
            reason: UploadPauseReason::NetworkUnavailable,
        })
    );
    Ok(())
}
