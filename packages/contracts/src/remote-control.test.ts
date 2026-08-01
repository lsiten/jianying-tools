import { describe, expect, test } from "vitest";

import {
  iceServerDescriptorSchema,
  REMOTE_CONTROL_MESSAGE_TYPES,
  remoteControlMacResponseSchema,
} from "./remote-control.js";

describe("remote-control ICE server descriptors", () => {
  test("accepts Cloudflare's browser-safe short-lived TURN credentials in a transfer response", () => {
    // Given: the local server has minted a per-session Cloudflare TURN credential.
    const response = {
      expiresAtEpochMs: 123_000,
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        {
          credential: "short-lived-password",
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "short-lived-user",
        },
      ],
      maxChunkBytes: 1_048_576,
      mobileSignalingToken: "mobile-token",
      requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      sessionId: "7ee77da2-3d07-4d91-b290-f2c560ae046d",
      transferGrant: "transfer-grant",
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED,
      uploadId: "6ee77da2-3d07-4d91-b290-f2c560ae046d",
    };

    // When: the mobile control protocol validates the trusted response.
    const parsed = remoteControlMacResponseSchema.parse(response);

    // Then: only the short-lived credential crosses the public transfer boundary.
    expect(parsed).toMatchObject({ iceServers: response.iceServers });
  });

  test("rejects a relay descriptor without both short-lived credential fields", () => {
    // Given: a malformed relay configuration missing its password.
    const malformed = {
      urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
      username: "short-lived-user",
    };

    // Then: no browser peer can be created with an unusable or partial credential.
    expect(() => iceServerDescriptorSchema.parse(malformed)).toThrow();
  });
});
