import { createHmac } from "node:crypto";
import type { SignalingTokenPayload } from "@jianying/contracts";

/** Produces the short-lived token understood by the Cloudflare signaling Worker. */
export function createSignalingToken(input: {
  readonly payload: SignalingTokenPayload;
  readonly secret: string;
}): string {
  const encodedPayload = Buffer.from(JSON.stringify(input.payload)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", input.secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}
