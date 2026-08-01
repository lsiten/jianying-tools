import {
  type SignalingMessage,
  webRtcSessionIdSchema,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import type {
  CloudflareSignalingClient,
  CloudflareSignalingConnection,
} from "./cloudflare-signaling-client.js";
import { createSessionSignalingGateway } from "./session-signaling-gateway.js";

describe("session signaling gateway", () => {
  test("forwards a connection failure through the matching Mac signaling connection", async () => {
    // Given: a connected Cloudflare socket registered for one WebRTC session.
    const client = new FakeCloudflareSignalingClient();
    const inbound: SignalingMessage[] = [];
    const gateway = createSessionSignalingGateway({
      signalingClient: client,
      workerBaseUrl: "https://signal.example.workers.dev",
    });
    const sessionId = webRtcSessionIdSchema.parse(
      "5f85a2f2-39b1-45fd-ae07-b6fed7b95207",
    );
    await gateway.connectMacSession({
      macSignalingToken: "mac-token",
      onMessage: (message) => inbound.push(message),
      onSessionError: () => undefined,
      sessionId,
    });

    // When: the local coordinator reports a failed connection.
    gateway.forwardOutbound({
      reason: "CONNECTION_FAILED",
      sessionId,
      type: "close",
    });

    // Then: only that session's Mac socket receives the typed rejection frame.
    expect(client.connection.sent).toEqual([
      {
        reason: "CONNECTION_FAILED",
        sessionId,
        type: "close",
      },
    ]);
    expect(client.connection.closed).toBe(true);
    expect(inbound).toEqual([]);
  });

  test("removes a disconnected socket before later coordinator output can be sent", async () => {
    // Given: a session that was connected to the Worker and then loses WSS.
    const client = new FakeCloudflareSignalingClient();
    const errors: string[] = [];
    const gateway = createSessionSignalingGateway({
      signalingClient: client,
      workerBaseUrl: "https://signal.example.workers.dev",
    });
    const sessionId = webRtcSessionIdSchema.parse(
      "5f85a2f2-39b1-45fd-ae07-b6fed7b95207",
    );
    await gateway.connectMacSession({
      macSignalingToken: "mac-token",
      onMessage: () => undefined,
      onSessionError: (error) => errors.push(error.message),
      sessionId,
    });
    client.disconnect();

    // When: a paid-relay rejection tries to report its terminal state after that disconnect.
    const forward = () =>
      gateway.forwardOutbound({
        reason: "CONNECTION_FAILED",
        sessionId,
        type: "close",
      });

    // Then: it cannot be misrouted to another session and the original failure is observable.
    expect(errors).toHaveLength(1);
    expect(forward).toThrow(
      expect.objectContaining({ reason: "SIGNALING_CONNECTION_UNAVAILABLE" }),
    );
  });
});

class FakeCloudflareSignalingClient implements CloudflareSignalingClient {
  readonly connection = new FakeCloudflareSignalingConnection();
  private onError: ((error: Error) => void) | undefined;

  async connect(input: {
    readonly onError?: (error: Error) => void;
    readonly onMessage: (message: SignalingMessage) => void;
    readonly sessionId: ReturnType<typeof webRtcSessionIdSchema.parse>;
    readonly token: string;
    readonly workerBaseUrl: string;
  }): Promise<CloudflareSignalingConnection> {
    this.onError = input.onError;
    return this.connection;
  }

  disconnect(): void {
    this.onError?.(new Error("Worker disconnected"));
  }
}

class FakeCloudflareSignalingConnection
  implements CloudflareSignalingConnection
{
  closed = false;
  readonly sent: SignalingMessage[] = [];

  close(): void {
    this.closed = true;
  }

  send(message: SignalingMessage): void {
    this.sent.push(message);
  }
}
