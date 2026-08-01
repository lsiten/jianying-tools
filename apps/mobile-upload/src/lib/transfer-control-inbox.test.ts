import { uploadIdSchema } from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import { TransferControlInbox } from "./transfer-control-inbox.js";
import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";

describe("transfer control inbox", () => {
  test("preserves the first terminal error when WebSocket close follows it", async () => {
    // Given: a transfer failure reaches the browser just before signaling closes.
    const inbox = new TransferControlInbox();
    const connectionFailed = new WebRtcFileTransferError("CONNECTION_FAILED");
    inbox.reject(connectionFailed);
    inbox.reject(new WebRtcFileTransferError("CONNECTION_FAILED"));

    // When: the uploader next waits for its terminal control result.
    const wait = inbox.waitFor(
      uploadIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      () => true,
    );

    // Then: the original failure remains exact rather than being replaced by socket teardown.
    await expect(wait).rejects.toBe(connectionFailed);
  });
});
