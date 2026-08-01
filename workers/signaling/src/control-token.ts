import {
  type ControlTokenPayload,
  controlTokenPayloadSchema,
} from "@jianying/contracts";

export const CONTROL_TOKEN_REJECTION_REASONS = {
  INVALID_TOKEN: "INVALID_TOKEN",
  NODE_MISMATCH: "NODE_MISMATCH",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
} as const;

export type ControlTokenVerification =
  | { readonly kind: "accepted"; readonly payload: ControlTokenPayload }
  | {
      readonly kind: "rejected";
      readonly reason: (typeof CONTROL_TOKEN_REJECTION_REASONS)[keyof typeof CONTROL_TOKEN_REJECTION_REASONS];
    };

export async function verifyControlToken(input: {
  readonly nodeId: string;
  readonly nowEpochMs: number;
  readonly secret: string;
  readonly token: string;
}): Promise<ControlTokenVerification> {
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
  if (payload.nodeId !== input.nodeId) {
    return rejected("NODE_MISMATCH");
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
    return Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
  } catch (error) {
    if (error instanceof DOMException) {
      return undefined;
    }
    throw error;
  }
}

function parseTokenPayload(bytes: Uint8Array): ControlTokenPayload | undefined {
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  const parsed = controlTokenPayloadSchema.safeParse(rawPayload);
  return parsed.success ? parsed.data : undefined;
}

function rejected(
  reason: (typeof CONTROL_TOKEN_REJECTION_REASONS)[keyof typeof CONTROL_TOKEN_REJECTION_REASONS],
): ControlTokenVerification {
  return { kind: "rejected", reason };
}
