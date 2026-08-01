import { afterEach, describe, expect, test, vi } from "vitest";

import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";
import {
  assertIceServers,
  DATA_CHANNEL_OPEN_TIMEOUT_MS,
  type DataChannelOpenOptions,
  type DataChannelOpenTarget,
  waitForDataChannelOpen,
} from "./webrtc-transfer-protocol.js";

describe("WebRTC ICE transfer policy", () => {
  afterEach(() => vi.useRealTimers());

  test("accepts an explicit TURN endpoint when it carries short-lived credentials", () => {
    expect(() =>
      assertIceServers([
        {
          credential: "short-lived-password",
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "short-lived-user",
        },
      ]),
    ).not.toThrow();
  });

  test("rejects an empty ICE response", () => {
    expectReason(() => assertIceServers([]), "SIGNALING_INVALID");
  });

  test("reports CONNECTION_FAILED when a direct data channel never opens", async () => {
    // Given: a connection whose channel remains in the connecting state.
    vi.useFakeTimers();
    const channel: DataChannelOpenTarget = {
      onerror: null,
      onopen: null,
      readyState: "connecting",
    };

    // When: the browser waits for the direct channel to become usable.
    const waiting = waitForDataChannelOpen(channel);
    const expectation = expect(waiting).rejects.toMatchObject({
      reason: "CONNECTION_FAILED",
    });
    await vi.advanceTimersByTimeAsync(DATA_CHANNEL_OPEN_TIMEOUT_MS);

    // Then: a stalled route remains observable to the uploader.
    await expectation;
  });

  test("stops waiting immediately when the peer reports a direct connection failure", async () => {
    // Given: a connecting data channel and an owning peer's failure signal.
    const channel: DataChannelOpenTarget = {
      onerror: null,
      onopen: null,
      readyState: "connecting",
    };
    const controller = new AbortController();
    const options: DataChannelOpenOptions = {
      failureSignal: controller.signal,
    };

    // When: ICE reports the peer connection as failed.
    const waiting = waitForDataChannelOpen(channel, options);
    const expectation = expect(waiting).rejects.toMatchObject({
      reason: "CONNECTION_FAILED",
    });
    controller.abort();

    // Then: the H5 reports the failure immediately and does not wait for a channel event.
    await expectation;
  });
});

function expectReason(
  operation: () => void,
  reason: WebRtcFileTransferError["reason"],
): void {
  try {
    operation();
    throw new Error("Expected ICE validation to reject the configuration");
  } catch (error) {
    expect(error).toBeInstanceOf(WebRtcFileTransferError);
    if (error instanceof WebRtcFileTransferError) {
      expect(error.reason).toBe(reason);
    }
  }
}
