import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type {
  DeviceId,
  TransferControlMessage,
  UploadId,
  WebRtcSessionId,
} from "@jianying/contracts";

import type {
  TransferAuthorization,
  TransferAuthorizationResult,
} from "./incoming-upload-receiver.js";

export type PairedDevicePublicKey = {
  readonly deviceId: DeviceId;
  readonly publicKeySpkiBase64Url: string;
};

/** Builds the versioned, length-delimited payload that a mobile secure key signs for one transfer. */
export function createDeviceAuthorizationPayload(input: {
  readonly deviceId: DeviceId;
  readonly dtlsFingerprint: string;
  readonly grant: string;
  readonly sessionId: WebRtcSessionId;
  readonly uploadId: UploadId;
}): Buffer {
  return Buffer.from(
    [
      "jianying-transfer-authorize-v1",
      input.deviceId,
      input.sessionId,
      input.uploadId,
      input.grant,
      input.dtlsFingerprint,
    ]
      .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
      .join("|"),
    "utf8",
  );
}

/** Verifies that a control-channel grant is held by the paired device selected for this transfer. */
export function createPairedDeviceAuthorization(input: {
  readonly expectedDeviceId: DeviceId;
  readonly expectedGrant: string;
  readonly getPairedDevice: (
    deviceId: DeviceId,
  ) => PairedDevicePublicKey | undefined;
  readonly sessionId: WebRtcSessionId;
  readonly uploadId: UploadId;
}): TransferAuthorization {
  return (authorization) => {
    if (
      authorization.deviceId !== input.expectedDeviceId ||
      !sameSecret(authorization.grant, input.expectedGrant)
    ) {
      return rejected("AUTHORIZE_REJECTED");
    }
    const device = input.getPairedDevice(authorization.deviceId);
    if (device === undefined) {
      return rejected("DEVICE_NOT_PAIRED");
    }
    return verifiesDeviceProof(device, authorization, input)
      ? { kind: "accepted" }
      : rejected("DEVICE_PROOF_INVALID");
  };
}

function verifiesDeviceProof(
  device: PairedDevicePublicKey,
  authorization: Extract<
    TransferControlMessage,
    { readonly type: "authorize" }
  >,
  input: {
    readonly expectedDeviceId: DeviceId;
    readonly expectedGrant: string;
    readonly sessionId: WebRtcSessionId;
    readonly uploadId: UploadId;
  },
): boolean {
  try {
    const publicKey = createPublicKey({
      format: "der",
      key: Buffer.from(device.publicKeySpkiBase64Url, "base64url"),
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return false;
    }
    return verify(
      null,
      createDeviceAuthorizationPayload({
        deviceId: input.expectedDeviceId,
        dtlsFingerprint: authorization.dtlsFingerprint,
        grant: input.expectedGrant,
        sessionId: input.sessionId,
        uploadId: input.uploadId,
      }),
      publicKey,
      Buffer.from(authorization.deviceProof, "base64url"),
    );
  } catch (error) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}

function sameSecret(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    providedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

function rejected(
  reason: Exclude<
    import("./incoming-upload-receiver.js").TransferAuthorizationRejectionReason,
    "DTLS_FINGERPRINT_MISMATCH"
  >,
): TransferAuthorizationResult {
  return { kind: "rejected", reason };
}
