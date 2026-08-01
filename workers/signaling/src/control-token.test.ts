import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";

import { verifyControlToken } from "./control-token.js";

describe("Cloudflare control token verification", () => {
  test("accepts only a non-expired Mac token for its bound public node", async () => {
    // Given: a Mac control token for one public node rendezvous route.
    const nodeId = "t7NHTBv9_MpK3VxW6RzQ2A";
    const token = signToken(
      { expiresAtEpochMs: 2_000, nodeId, role: "mac" },
      "local-test-secret",
    );

    // When: the Worker validates the route-specific WebSocket token.
    const result = await verifyControlToken({
      nodeId,
      nowEpochMs: 1_999,
      secret: "local-test-secret",
      token,
    });

    // Then: it accepts the exact Mac-only claims and never authenticates a different node.
    expect(result).toEqual({
      kind: "accepted",
      payload: { expiresAtEpochMs: 2_000, nodeId, role: "mac" },
    });
  });
});

function signToken(
  payload: {
    readonly expiresAtEpochMs: number;
    readonly nodeId: string;
    readonly role: "mac";
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
