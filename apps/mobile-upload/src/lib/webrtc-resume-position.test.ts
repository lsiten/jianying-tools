import { describe, expect, test } from "vitest";

import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";
import { createResumeTransferPosition } from "./webrtc-resume-position.js";

describe("WebRTC resume transfer position", () => {
  test("continues at the durable ACK offset instead of restarting the file", () => {
    expect(
      createResumeTransferPosition({
        fileSize: 3_100,
        maxChunkBytes: 1_024,
        receivedBytes: 2_048,
      }),
    ).toEqual({ chunkIndex: 2n, offsetBytes: 2_048 });
  });

  test("allows a completed final partial chunk to be committed after reconnect", () => {
    expect(
      createResumeTransferPosition({
        fileSize: 3_100,
        maxChunkBytes: 1_024,
        receivedBytes: 3_100,
      }),
    ).toEqual({ chunkIndex: 3n, offsetBytes: 3_100 });
  });

  test("rejects an ACK that cannot be the boundary of a persisted chunk", () => {
    expect(() =>
      createResumeTransferPosition({
        fileSize: 3_100,
        maxChunkBytes: 1_024,
        receivedBytes: 1_025,
      }),
    ).toThrow(WebRtcFileTransferError);
  });
});
