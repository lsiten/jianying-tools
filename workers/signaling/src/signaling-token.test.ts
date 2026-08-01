import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { verifySignalingToken } from "./signaling-token.js";

describe("Cloudflare signaling token verification", () => {
  test("accepts a valid non-expired HMAC session token", async () => {
    // Given: a Mac-issued mobile token with a matching room, secret, and expiry.
    const sessionId = randomUUID();
    const token = signToken(
      {
        expiresAtEpochMs: 2_000,
        role: "mobile",
        sessionId,
      },
      "local-test-secret",
    );

    // When: the Worker validates the WebSocket query token.
    const result = await verifySignalingToken({
      nowEpochMs: 1_999,
      secret: "local-test-secret",
      sessionId,
      token,
    });

    // Then: only its parsed, session-bound claims are accepted.
    expect(result).toEqual({
      kind: "accepted",
      payload: {
        expiresAtEpochMs: 2_000,
        role: "mobile",
        sessionId,
      },
    });
  });

  test("rejects a token after its expiry without forwarding a signal", async () => {
    // Given: an otherwise valid token that has already expired.
    const sessionId = randomUUID();
    const token = signToken(
      {
        expiresAtEpochMs: 2_000,
        role: "mac",
        sessionId,
      },
      "local-test-secret",
    );

    // When: the same token arrives after its declared expiration.
    const result = await verifySignalingToken({
      nowEpochMs: 2_000,
      secret: "local-test-secret",
      sessionId,
      token,
    });

    // Then: the Durable Object is never reached.
    expect(result).toEqual({ kind: "rejected", reason: "TOKEN_EXPIRED" });
  });
});

function signToken(
  payload: {
    readonly expiresAtEpochMs: number;
    readonly role: "mac" | "mobile";
    readonly sessionId: string;
  },
  secret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}
