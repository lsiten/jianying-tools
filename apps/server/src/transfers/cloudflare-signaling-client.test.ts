import {
  type SignalingMessage,
  webRtcSessionIdSchema,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import {
  createCloudflareSignalingClient,
  type SignalingSocket,
} from "./cloudflare-signaling-client.js";

describe("Cloudflare signaling client", () => {
  test("relays a typed CONNECTION_FAILED close frame over the session-bound WSS connection", async () => {
    // Given: an opened Mac-role socket for one short-lived upload session.
    const socket = new FakeSignalingSocket();
    const received: SignalingMessage[] = [];
    const client = createCloudflareSignalingClient({
      connectTimeoutMs: 1_000,
      createSocket: (url) => {
        expect(url).toBe(
          "wss://signal.example.workers.dev/v1/signal/13f2ef55-2a3f-4a62-93e7-5f28e3a7f243?token=mac-token",
        );
        return socket;
      },
    });
    const opening = client.connect({
      onMessage: (message) => received.push(message),
      sessionId: webRtcSessionIdSchema.parse(
        "13f2ef55-2a3f-4a62-93e7-5f28e3a7f243",
      ),
      token: "mac-token",
      workerBaseUrl: "https://signal.example.workers.dev",
    });
    socket.open();
    const connection = await opening;

    // When: the coordinator reports a failed peer connection.
    connection.send({
      reason: "CONNECTION_FAILED",
      sessionId: webRtcSessionIdSchema.parse(
        "13f2ef55-2a3f-4a62-93e7-5f28e3a7f243",
      ),
      type: "close",
    });

    // Then: the Worker receives only the typed control frame, never a media payload.
    expect(socket.sent).toEqual([
      JSON.stringify({
        reason: "CONNECTION_FAILED",
        sessionId: "13f2ef55-2a3f-4a62-93e7-5f28e3a7f243",
        type: "close",
      }),
    ]);
    expect(received).toEqual([]);
  });

  test("rejects a Worker message whose session does not match this socket", async () => {
    // Given: a connection carrying a token for one upload session.
    const socket = new FakeSignalingSocket();
    const client = createCloudflareSignalingClient({
      connectTimeoutMs: 1_000,
      createSocket: () => socket,
    });
    const opening = client.connect({
      onMessage: () => undefined,
      sessionId: webRtcSessionIdSchema.parse(
        "13f2ef55-2a3f-4a62-93e7-5f28e3a7f243",
      ),
      token: "mac-token",
      workerBaseUrl: "https://signal.example.workers.dev",
    });
    socket.open();
    await opening;

    // When: an unexpected room message is delivered to this WebSocket.
    socket.message(
      JSON.stringify({
        candidate: "candidate:wrong-room",
        mid: "0",
        sessionId: "99ea3472-1f15-45a7-b4d5-a016543e2bbc",
        type: "candidate",
      }),
    );

    // Then: the client closes rather than forwarding another session's ICE data.
    expect(socket.closed).toBe(true);
  });

  test("reports an unexpected Worker disconnect after the session is open", async () => {
    // Given: an opened signaling socket with an application error observer.
    const socket = new FakeSignalingSocket();
    const errors: string[] = [];
    const client = createCloudflareSignalingClient({
      connectTimeoutMs: 1_000,
      createSocket: () => socket,
    });
    const opening = client.connect({
      onError: (error) => errors.push(error.reason),
      onMessage: () => undefined,
      sessionId: webRtcSessionIdSchema.parse(
        "13f2ef55-2a3f-4a62-93e7-5f28e3a7f243",
      ),
      token: "mac-token",
      workerBaseUrl: "https://signal.example.workers.dev",
    });
    socket.open();
    await opening;

    // When: the remote Worker connection goes away before a deliberate local close.
    socket.close();

    // Then: the runtime can pause the upload instead of silently losing signaling.
    expect(errors).toEqual(["CONNECTION_CLOSED"]);
  });
});

class FakeSignalingSocket implements SignalingSocket {
  closed = false;
  onclose: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;
  readonly sent: string[] = [];

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  message(data: unknown): void {
    this.onmessage?.(data);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }
}
