import { describe, expect, test } from "vitest";

import {
  isWebRtcSessionRefreshable,
  WebRtcFileTransferError,
} from "./webrtc-file-transfer-error.js";

describe("WebRTC session refreshability", () => {
  test("accepts transient relay connection failures", () => {
    // Given: the peer cannot establish a relay connection.
    const error = new WebRtcFileTransferError("CONNECTION_FAILED");

    // When: the upload coordinator decides whether to mint a fresh session.
    const refreshable = isWebRtcSessionRefreshable(error);

    // Then: the interrupted durable upload can safely resume with new credentials.
    expect(refreshable).toBe(true);
  });

  test("rejects protocol failures from transparent retries", () => {
    // Given: the Mac has rejected the transfer control protocol.
    const error = new WebRtcFileTransferError("CONTROL_REJECTED");

    // When: the upload coordinator decides whether to mint a fresh session.
    const refreshable = isWebRtcSessionRefreshable(error);

    // Then: it does not hide a non-network failure by retrying it.
    expect(refreshable).toBe(false);
  });
});
