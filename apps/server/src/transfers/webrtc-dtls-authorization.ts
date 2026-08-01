import type {
  TransferAuthorization,
  TransferAuthorizationResult,
} from "./incoming-upload-receiver.js";

type RemoteDtlsFingerprintPeer = {
  readonly remoteFingerprint: () => {
    readonly algorithm: string;
    readonly value: string;
  };
};

/** Binds a signed transfer grant to the exact peer certificate negotiated by DTLS. */
export function createDtlsBoundAuthorization(input: {
  readonly authorize?: TransferAuthorization;
  readonly peer: RemoteDtlsFingerprintPeer;
}): TransferAuthorization {
  return async (authorization) => {
    if (!matchesRemoteFingerprint(input.peer, authorization.dtlsFingerprint)) {
      return {
        kind: "rejected",
        reason: "DTLS_FINGERPRINT_MISMATCH",
      };
    }
    return input.authorize?.(authorization) ?? rejectedAuthorization();
  };
}

function matchesRemoteFingerprint(
  peer: RemoteDtlsFingerprintPeer,
  suppliedFingerprint: string,
): boolean {
  try {
    const remoteFingerprint = peer.remoteFingerprint();
    return (
      remoteFingerprint.algorithm === "sha-256" &&
      canonicalSha256Fingerprint(remoteFingerprint.value) ===
        canonicalSha256Fingerprint(suppliedFingerprint)
    );
  } catch (error) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}

function canonicalSha256Fingerprint(value: string): string | undefined {
  const hexadecimal = value.replaceAll(":", "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(hexadecimal) ? hexadecimal : undefined;
}

function rejectedAuthorization(): TransferAuthorizationResult {
  return { kind: "rejected", reason: "AUTHORIZE_REJECTED" };
}
