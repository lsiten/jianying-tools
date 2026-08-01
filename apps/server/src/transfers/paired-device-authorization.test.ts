import { generateKeyPairSync, sign } from "node:crypto";
import {
  deviceIdSchema,
  type TransferControlMessage,
  uploadIdSchema,
  webRtcSessionIdSchema,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import {
  createDeviceAuthorizationPayload,
  createPairedDeviceAuthorization,
} from "./paired-device-authorization.js";

describe("paired device authorization", () => {
  test("accepts an Ed25519 proof bound to this device, session, upload, grant, and DTLS certificate", async () => {
    // Given: one paired phone's public key and a proof covering every transferable capability.
    const keyPair = generateKeyPairSync("ed25519");
    const authorizationInput = authorizationMessage({
      deviceProof: sign(
        null,
        createDeviceAuthorizationPayload({
          deviceId: deviceId(),
          dtlsFingerprint: "a1:b2:c3:d4",
          grant: "one-time-grant",
          sessionId: sessionId(),
          uploadId: uploadId(),
        }),
        keyPair.privateKey,
      ).toString("base64url"),
    });
    const authorize = createPairedDeviceAuthorization({
      expectedDeviceId: deviceId(),
      expectedGrant: "one-time-grant",
      getPairedDevice: (requestedDeviceId) =>
        requestedDeviceId === deviceId()
          ? {
              deviceId: deviceId(),
              publicKeySpkiBase64Url: keyPair.publicKey
                .export({ format: "der", type: "spki" })
                .toString("base64url"),
            }
          : undefined,
      sessionId: sessionId(),
      uploadId: uploadId(),
    });

    // When: that device authorizes the WebRTC control channel.
    const result = await authorize(authorizationInput);

    // Then: only a cryptographically bound proof may start material transfer.
    expect(result).toEqual({ kind: "accepted" });
  });

  test("rejects a valid signature replayed for another session", async () => {
    // Given: a paired device signature originally made for a separate WebRTC session.
    const keyPair = generateKeyPairSync("ed25519");
    const proof = sign(
      null,
      createDeviceAuthorizationPayload({
        deviceId: deviceId(),
        dtlsFingerprint: "a1:b2:c3:d4",
        grant: "one-time-grant",
        sessionId: webRtcSessionIdSchema.parse(
          "420e6c0b-48f7-4baa-bccc-c6e5e5a44887",
        ),
        uploadId: uploadId(),
      }),
      keyPair.privateKey,
    ).toString("base64url");
    const authorize = createPairedDeviceAuthorization({
      expectedDeviceId: deviceId(),
      expectedGrant: "one-time-grant",
      getPairedDevice: () => ({
        deviceId: deviceId(),
        publicKeySpkiBase64Url: keyPair.publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64url"),
      }),
      sessionId: sessionId(),
      uploadId: uploadId(),
    });

    // When: the phone reuses that proof for this otherwise identical transfer.
    const result = await authorize(
      authorizationMessage({ deviceProof: proof }),
    );

    // Then: the signature cannot authorize a different signaling session.
    expect(result).toEqual({
      kind: "rejected",
      reason: "DEVICE_PROOF_INVALID",
    });
  });
});

function authorizationMessage(input: {
  readonly deviceProof: string;
}): Extract<TransferControlMessage, { readonly type: "authorize" }> {
  return {
    deviceId: deviceId(),
    deviceProof: input.deviceProof,
    dtlsFingerprint: "a1:b2:c3:d4",
    grant: "one-time-grant",
    type: "authorize",
    uploadId: uploadId(),
  };
}

function deviceId() {
  return deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d");
}

function sessionId() {
  return webRtcSessionIdSchema.parse("9c6c3aa9-0b47-49e7-a6a2-f69caf9b0565");
}

function uploadId() {
  return uploadIdSchema.parse("f3ba5d3e-eb98-4095-b1b0-48c4e8d98667");
}
