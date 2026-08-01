import { randomUUID } from "node:crypto";
import { signalingTokenPayloadSchema } from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import { verifySignalingToken } from "../../../../workers/signaling/src/signaling-token.js";
import { createSignalingToken } from "./signaling-token.js";

describe("Mac-to-Cloudflare signaling token compatibility", () => {
  test("creates a token accepted by the Worker verifier for the same session", async () => {
    // Given: a locally issued macOS signaling claim.
    const payload = signalingTokenPayloadSchema.parse({
      expiresAtEpochMs: 2_000,
      role: "mac",
      sessionId: randomUUID(),
    });
    const token = createSignalingToken({
      payload,
      secret: "local-test-secret",
    });

    // When: the Cloudflare-compatible verifier checks that exact room and secret.
    const result = await verifySignalingToken({
      nowEpochMs: 1_999,
      secret: "local-test-secret",
      sessionId: payload.sessionId,
      token,
    });

    // Then: the Worker receives the same role and expiry the Mac signed.
    expect(result).toEqual({ kind: "accepted", payload });
  });
});
