import { uploadIdSchema, webRtcSessionIdSchema } from "@jianying/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TransferControlInbox } from "./transfer-control-inbox.js";
import {
  type MobileSignalingPeer,
  openMobileSignalingClient,
} from "./webrtc-signaling-client.js";

describe("mobile signaling client", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("reports CONNECTION_FAILED when an opened signaling socket emits an error", async () => {
    // Given: an opened mobile signaling socket and an active transfer-control waiter.
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const inbox = new TransferControlInbox();
    const client = openMobileSignalingClient({
      inbox,
      peer: fakePeer(),
      sessionId: webRtcSessionIdSchema.parse(
        "2ee77da2-3d07-4d91-b290-f2c560ae046d",
      ),
      token: "mobile-token",
      workerBaseUrl: "https://signal.example.workers.dev",
    });
    const socket = FakeWebSocket.latest;
    if (socket === undefined) {
      throw new Error("Expected the signaling client to create a WebSocket");
    }
    socket.open();
    await client.opened;
    const waiting = inbox.waitFor(
      uploadIdSchema.parse("3ee77da2-3d07-4d91-b290-f2c560ae046d"),
      () => true,
    );
    const expectation = expect(waiting).rejects.toMatchObject({
      reason: "CONNECTION_FAILED",
    });

    // When: the browser reports a socket error before its close event arrives.
    socket.error();

    // Then: the transfer fails immediately as a normal direct-connection failure.
    await expectation;
    client.close();
  });
});

class FakeWebSocket {
  static latest: FakeWebSocket | undefined;

  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  private closeListener: (() => void) | undefined;

  constructor(_url: string) {
    FakeWebSocket.latest = this;
  }

  addEventListener(
    eventName: "close",
    listener: () => void,
    _options: { readonly once: true },
  ): void {
    if (eventName === "close") {
      this.closeListener = listener;
    }
  }

  close(): void {
    this.onclose?.();
    this.closeListener?.();
  }

  error(): void {
    this.onerror?.();
  }

  open(): void {
    this.onopen?.();
  }

  send(_message: string): void {}
}

function fakePeer(): MobileSignalingPeer {
  return {
    addIceCandidate: async () => undefined,
    setRemoteDescription: async () => undefined,
  };
}
