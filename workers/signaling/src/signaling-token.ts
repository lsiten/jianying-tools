import {
  type SignalingTokenPayload,
  signalingTokenPayloadSchema,
} from "@jianying/contracts";

export const SIGNALING_TOKEN_REJECTION_REASONS = {
  INVALID_TOKEN: "INVALID_TOKEN",
  SESSION_MISMATCH: "SESSION_MISMATCH",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
} as const;

export type SignalingTokenRejectionReason =
  (typeof SIGNALING_TOKEN_REJECTION_REASONS)[keyof typeof SIGNALING_TOKEN_REJECTION_REASONS];

export type SignalingTokenVerification =
  | { readonly kind: "accepted"; readonly payload: SignalingTokenPayload }
  | {
      readonly kind: "rejected";
      readonly reason: SignalingTokenRejectionReason;
    };

export async function verifySignalingToken(input: {
  readonly nowEpochMs: number;
  readonly secret: string;
  readonly sessionId: string;
  readonly token: string;
}): Promise<SignalingTokenVerification> {
  const parts = input.token.split(".");
  const encodedPayload = parts[0];
  const encodedSignature = parts[1];
  if (
    parts.length !== 2 ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return rejected("INVALID_TOKEN");
  }

  const payloadBytes = decodeBase64Url(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (payloadBytes === undefined || signature === undefined) {
    return rejected("INVALID_TOKEN");
  }
  const payload = parseTokenPayload(payloadBytes);
  if (payload === undefined) {
    return rejected("INVALID_TOKEN");
  }
  if (payload.sessionId !== input.sessionId) {
    return rejected("SESSION_MISMATCH");
  }
  if (payload.expiresAtEpochMs <= input.nowEpochMs) {
    return rejected("TOKEN_EXPIRED");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(encodedPayload),
  );
  return valid ? { kind: "accepted", payload } : rejected("INVALID_TOKEN");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch (error) {
    if (error instanceof DOMException) {
      return undefined;
    }
    throw error;
  }
}

function parseTokenPayload(
  bytes: Uint8Array,
): SignalingTokenPayload | undefined {
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  const parsed = signalingTokenPayloadSchema.safeParse(rawPayload);
  return parsed.success ? parsed.data : undefined;
}

function rejected(
  reason: SignalingTokenRejectionReason,
): SignalingTokenVerification {
  return { kind: "rejected", reason };
}
