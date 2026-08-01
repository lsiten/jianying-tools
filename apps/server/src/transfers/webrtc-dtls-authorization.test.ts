import {
  deviceIdSchema,
  type TransferControlMessage,
  uploadIdSchema,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import { createDtlsBoundAuthorization } from "./webrtc-dtls-authorization.js";

describe("DTLS-bound transfer authorization", () => {
  test("accepts a grant only when its fingerprint is the actual remote SHA-256 fingerprint", async () => {
    // Given: an authenticated transfer grant and the peer certificate selected by DTLS.
    const authorization = createDtlsBoundAuthorization({
      authorize: () => ({ kind: "accepted" }),
      peer: {
        remoteFingerprint: () => ({
          algorithm: "sha-256",
          value:
            "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:12:23:34:45:56:67:78:89:9A:AB:BC:CD:DE:EF:01:02",
        }),
      },
    });

    // When: the mobile control channel supplies that exact certificate fingerprint.
    const result = await authorization(
      authorizationMessage(
        "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:12:23:34:45:56:67:78:89:9A:AB:BC:CD:DE:EF:01:02",
      ),
    );

    // Then: the grant becomes usable only for the authenticated peer connection.
    expect(result).toEqual({ kind: "accepted" });
  });

  test("rejects a valid grant replayed from a peer with another DTLS certificate", async () => {
    // Given: the same grant handler but a different certificate supplied over the control channel.
    const authorization = createDtlsBoundAuthorization({
      authorize: () => ({ kind: "accepted" }),
      peer: {
        remoteFingerprint: () => ({
          algorithm: "sha-256",
          value:
            "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:12:23:34:45:56:67:78:89:9A:AB:BC:CD:DE:EF:01:02",
        }),
      },
    });

    // When: a different peer tries to reuse the otherwise valid grant.
    const result = await authorization(
      authorizationMessage(
        "FF:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:12:23:34:45:56:67:78:89:9A:AB:BC:CD:DE:EF:01:02",
      ),
    );

    // Then: data cannot be accepted from that connection.
    expect(result).toEqual({
      kind: "rejected",
      reason: "DTLS_FINGERPRINT_MISMATCH",
    });
  });
});

function authorizationMessage(
  dtlsFingerprint: string,
): Extract<TransferControlMessage, { readonly type: "authorize" }> {
  return {
    deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
    deviceProof: "device-proof",
    dtlsFingerprint,
    grant: "transfer-grant",
    type: "authorize",
    uploadId: uploadIdSchema.parse("0d1a1840-a432-4030-939b-2e7e015a4e7e"),
  };
}
