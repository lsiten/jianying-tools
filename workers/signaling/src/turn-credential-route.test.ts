import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import { forwardTurnCredentialRequest } from "./turn-credential-route.js";

const nodeId = "t7NHTBv9_MpK3VxW6RzQ2A";
const secret = "hmac-secret-for-turn-worker-route";

describe("TURN credential route", () => {
  test("issues short-lived ICE settings when the local Mac presents a valid control token", async () => {
    // Given: an authenticated local request and the Worker-only Cloudflare TURN credential.
    const requestCredentials = vi.fn(async () =>
      Response.json({
        iceServers: [
          {
            credential: "short-lived-credential",
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: "short-lived-username",
          },
        ],
      }),
    );
    const request = new Request(
      `https://signal.example.workers.dev/v1/turn/${nodeId}?token=${createControlToken(
        1_700_000_100_000,
      )}`,
      { body: JSON.stringify({ ttl: 86_400 }), method: "POST" },
    );

    // When: the request reaches the Worker route.
    const response = await forwardTurnCredentialRequest({
      nodeId,
      nowEpochMs: 1_700_000_000_000,
      request,
      requestCredentials,
      secret,
      turnApiToken: "worker-only-turn-api-token",
      turnKeyId: "worker-only-turn-key-id",
    });

    // Then: only the short-lived ICE response is returned after Cloudflare receives the worker secret.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      iceServers: [
        {
          credential: "short-lived-credential",
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "short-lived-username",
        },
      ],
    });
    expect(requestCredentials).toHaveBeenCalledWith({
      apiToken: "worker-only-turn-api-token",
      keyId: "worker-only-turn-key-id",
      ttlSeconds: 86_400,
    });
  });

  test("rejects an invalid control token before the Worker requests credentials", async () => {
    // Given: a request that cannot prove it originated from this local Mac.
    const requestCredentials = vi.fn(async () => Response.json({}));
    const request = new Request(
      `https://signal.example.workers.dev/v1/turn/${nodeId}?token=invalid`,
      { body: JSON.stringify({ ttl: 86_400 }), method: "POST" },
    );

    // When: the route verifies the request.
    const response = await forwardTurnCredentialRequest({
      nodeId,
      nowEpochMs: 1_700_000_000_000,
      request,
      requestCredentials,
      secret,
      turnApiToken: "worker-only-turn-api-token",
      turnKeyId: "worker-only-turn-key-id",
    });

    // Then: no TURN credential request leaves the Worker.
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "TOKEN_REJECTED" });
    expect(requestCredentials).not.toHaveBeenCalled();
  });
});

function createControlToken(expiresAtEpochMs: number): string {
  const payload = Buffer.from(
    JSON.stringify({ expiresAtEpochMs, nodeId, role: "mac" }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
