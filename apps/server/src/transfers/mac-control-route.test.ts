import {
  deviceIdSchema,
  REMOTE_CONTROL_MESSAGE_TYPES,
  type RemoteControlMobileRequest,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import { createMacControlRoute } from "./mac-control-route.js";

describe("Mac control route", () => {
  test("forwards a Worker-routed Key request to the local authorization handler", () => {
    // Given: a configured Worker and a synthetic browser control request.
    const socket = new FakeControlSocket();
    const received: RemoteControlMobileRequest[] = [];
    const route = createMacControlRoute({
      connectTimeoutMs: 1_000,
      createSocket: () => socket,
      nodeId: "t7NHTBv9_MpK3VxW6RzQ2A",
      nowEpochMs: () => 1_000,
      onRequest: (request) => received.push(request),
      secret: "local-test-secret",
      workerBaseUrl: "https://signal.example.workers.dev",
    });

    // When: the persistent Mac connection opens and receives the valid Worker frame.
    route.start();
    socket.open();
    socket.message({
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      displayName: "iPhone Safari",
      publicKeySpkiBase64Url: "test_public_key",
      rawKey:
        "jyup1.t7NHTBv9_MpK3VxW6RzQ2A.5ee77da2-3d07-4d91-b290-f2c560ae046d.test_secret",
      requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REQUEST,
    });

    // Then: only parsed control input reaches the local Key service.
    expect(received).toEqual([
      expect.objectContaining({
        displayName: "iPhone Safari",
        requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      }),
    ]);
    route.stop();
  });
});

class FakeControlSocket {
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  message(value: unknown): void {
    this.onmessage?.(JSON.stringify(value));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(_data: string): void {}
}
