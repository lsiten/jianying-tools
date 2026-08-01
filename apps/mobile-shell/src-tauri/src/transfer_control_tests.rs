use crate::{
    transfer_control::{TransferBinding, TransferCloseOutcome, TransferControl, TransferSessionId},
    upload_queue::{
        DecimalCounter, SourceFileFingerprint, UploadId, UploadPauseReason, UploadProgress,
        UploadQueue, UploadQueueEntry, UploadQueueError, UploadQueueStatus,
    },
};

#[test]
fn pauses_only_the_bound_upload_when_connection_fails() -> Result<(), Box<dyn std::error::Error>> {
    // Given: a large active batch and a terminal close event for exactly one bound session.
    let directory = tempfile::tempdir()?;
    let queue_path = directory.path().join("upload-queue.json");
    let queue = UploadQueue::open(&queue_path)?;
    let control = TransferControl::new();
    let target_upload_id = UploadId::parse("target-upload")?;
    queue.enqueue(entry(&target_upload_id, directory.path())?)?;
    queue.set_status(&target_upload_id, UploadQueueStatus::Transferring)?;
    let target_session_id = TransferSessionId::parse("00000000-0000-4000-8000-000000000001")?;
    control.bind(TransferBinding {
        session_id: target_session_id.clone(),
        upload_id: target_upload_id.clone(),
    })?;
    for index in 2_u16..=1_025 {
        control.bind(TransferBinding {
            session_id: TransferSessionId::parse(&format!("00000000-0000-4000-8000-{index:012x}"))?,
            upload_id: UploadId::parse(&format!("batch-upload-{index}"))?,
        })?;
    }

    // When: the active session reports a failed WebRTC connection.
    let outcome = control.consume_close_json(
        &queue,
        &format!(
            r#"{{"type":"close","sessionId":"{}","reason":"CONNECTION_FAILED"}}"#,
            target_session_id.as_str()
        ),
    )?;
    drop(queue);

    // Then: the exact entry survives restart in a machine-readable network pause state.
    assert_eq!(
        outcome,
        TransferCloseOutcome::ConnectionFailed {
            upload_id: target_upload_id.clone(),
        }
    );
    let recovered = UploadQueue::open(&queue_path)?.snapshot()?;
    assert_eq!(
        recovered
            .entry(&target_upload_id)
            .map(|entry| &entry.status),
        Some(&UploadQueueStatus::Paused {
            reason: UploadPauseReason::NetworkUnavailable,
        })
    );
    Ok(())
}

#[test]
fn pauses_the_bound_upload_as_network_unavailable_for_a_connection_failure()
-> Result<(), Box<dyn std::error::Error>> {
    // Given: an active upload with one bound WebRTC session.
    let directory = tempfile::tempdir()?;
    let queue = UploadQueue::open(directory.path().join("upload-queue.json"))?;
    let control = TransferControl::new();
    let upload_id = UploadId::parse("direct-failure-upload")?;
    queue.enqueue(entry(&upload_id, directory.path())?)?;
    queue.set_status(&upload_id, UploadQueueStatus::Transferring)?;
    let session_id = TransferSessionId::parse("00000000-0000-4000-8000-000000000004")?;
    control.bind(TransferBinding {
        session_id: session_id.clone(),
        upload_id: upload_id.clone(),
    })?;

    // When: connectivity fails after ICE negotiation.
    let outcome = control.consume_close_json(
        &queue,
        &format!(
            r#"{{"type":"close","sessionId":"{}","reason":"CONNECTION_FAILED"}}"#,
            session_id.as_str()
        ),
    )?;

    // Then: it remains resumable and is not mislabeled as a billing decision.
    assert_eq!(
        outcome,
        TransferCloseOutcome::ConnectionFailed {
            upload_id: upload_id.clone(),
        }
    );
    assert_eq!(
        queue
            .snapshot()?
            .entry(&upload_id)
            .map(|entry| &entry.status),
        Some(&UploadQueueStatus::Paused {
            reason: UploadPauseReason::NetworkUnavailable,
        })
    );
    Ok(())
}

#[test]
fn ignores_a_terminal_close_for_an_unbound_session() -> Result<(), Box<dyn std::error::Error>> {
    // Given: a transferring upload associated with a different signaling session.
    let directory = tempfile::tempdir()?;
    let queue = UploadQueue::open(directory.path().join("upload-queue.json"))?;
    let upload_id = UploadId::parse("upload-a")?;
    queue.enqueue(entry(&upload_id, directory.path())?)?;
    queue.set_status(&upload_id, UploadQueueStatus::Transferring)?;
    let control = TransferControl::new();

    // When: a stale Worker close event arrives without a local binding.
    let outcome = control.consume_close_json(
        &queue,
        r#"{"type":"close","sessionId":"00000000-0000-4000-8000-000000000002","reason":"CONNECTION_FAILED"}"#,
    )?;

    // Then: it cannot pause an unrelated in-flight upload.
    assert_eq!(
        outcome,
        TransferCloseOutcome::UnboundSession {
            session_id: TransferSessionId::parse("00000000-0000-4000-8000-000000000002")?,
        }
    );
    assert_eq!(
        queue
            .snapshot()?
            .entry(&upload_id)
            .map(|entry| &entry.status),
        Some(&UploadQueueStatus::Transferring)
    );
    Ok(())
}

fn entry(
    upload_id: &UploadId,
    directory: &std::path::Path,
) -> Result<UploadQueueEntry, UploadQueueError> {
    Ok(UploadQueueEntry {
        upload_id: upload_id.clone(),
        source_path: directory.join(format!("{}.mov", upload_id.as_str())),
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
    })
}
