import { z } from "zod";

import { verifyControlToken } from "./control-token.js";

const turnCredentialRequestSchema = z.object({
  ttl: z.number().int().min(60),
});

export type TurnCredentialRequester = (input: {
  readonly apiToken: string;
  readonly keyId: string;
  readonly ttlSeconds: number;
}) => Promise<Response>;

export async function forwardTurnCredentialRequest(input: {
  readonly nodeId: string;
  readonly nowEpochMs: number;
  readonly request: Request;
  readonly requestCredentials: TurnCredentialRequester;
  readonly secret: string;
  readonly turnApiToken: string;
  readonly turnKeyId: string;
}): Promise<Response> {
  const token = new URL(input.request.url).searchParams.get("token");
  if (token === null) {
    return jsonError("TOKEN_REJECTED", 401);
  }
  const verification = await verifyControlToken({
    nodeId: input.nodeId,
    nowEpochMs: input.nowEpochMs,
    secret: input.secret,
    token,
  });
  if (verification.kind === "rejected") {
    return jsonError("TOKEN_REJECTED", 401);
  }
  const payload = await parsePayload(input.request);
  if (payload === undefined) {
    return jsonError("TURN_REQUEST_INVALID", 400);
  }
  const response = await input.requestCredentials({
    apiToken: input.turnApiToken,
    keyId: input.turnKeyId,
    ttlSeconds: payload.ttl,
  });
  if (!response.ok) {
    return jsonError("TURN_CREDENTIAL_REQUEST_FAILED", 502);
  }
  return new Response(response.body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    status: 200,
  });
}

export async function requestCloudflareTurnCredentials(input: {
  readonly apiToken: string;
  readonly keyId: string;
  readonly ttlSeconds: number;
}): Promise<Response> {
  return fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${input.keyId}/credentials/generate-ice-servers`,
    {
      body: JSON.stringify({ ttl: input.ttlSeconds }),
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
}

async function parsePayload(
  request: Request,
): Promise<{ readonly ttl: number } | undefined> {
  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  const parsed = turnCredentialRequestSchema.safeParse(rawPayload);
  return parsed.success ? parsed.data : undefined;
}

function jsonError(code: string, status: number): Response {
  return Response.json({ code }, { status });
}
