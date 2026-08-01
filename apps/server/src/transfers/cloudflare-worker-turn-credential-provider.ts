import { createHmac } from "node:crypto";
import {
  controlNodeIdSchema,
  controlTokenPayloadSchema,
} from "@jianying/contracts";
import { request } from "undici";

import {
  CloudflareTurnCredentialError,
  type IceServerResolver,
  parseBrowserIceServers,
} from "./cloudflare-turn-credential-provider.js";

export type WorkerTurnCredentialRequester = (input: {
  readonly body: { readonly ttl: number };
  readonly url: string;
}) => Promise<unknown>;

/** Requests per-session ICE servers while Cloudflare retains the long-lived TURN API token. */
export function createCloudflareWorkerTurnCredentialProvider(input: {
  readonly nodeId: string;
  readonly nowEpochMs?: () => number;
  readonly requestCredentials?: WorkerTurnCredentialRequester;
  readonly secret: string;
  readonly ttlSeconds: number;
  readonly workerBaseUrl: string;
}): IceServerResolver {
  controlNodeIdSchema.parse(input.nodeId);
  const requestCredentials =
    input.requestCredentials ?? requestWorkerTurnCredentials;
  const nowEpochMs = input.nowEpochMs ?? (() => Date.now());
  return {
    async resolveIceServers() {
      let response: unknown;
      try {
        response = await requestCredentials({
          body: { ttl: input.ttlSeconds },
          url: createTurnCredentialUrl({
            nodeId: input.nodeId,
            nowEpochMs: nowEpochMs(),
            secret: input.secret,
            workerBaseUrl: input.workerBaseUrl,
          }),
        });
      } catch {
        throw new CloudflareTurnCredentialError("CREDENTIAL_REQUEST_FAILED");
      }
      return parseBrowserIceServers(response);
    },
  };
}

async function requestWorkerTurnCredentials(input: {
  readonly body: { readonly ttl: number };
  readonly url: string;
}): Promise<unknown> {
  const response = await request(input.url, {
    body: JSON.stringify(input.body),
    bodyTimeout: 10_000,
    headers: { "content-type": "application/json" },
    headersTimeout: 10_000,
    method: "POST",
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    await response.body.dump();
    throw new CloudflareTurnCredentialError("CREDENTIAL_REQUEST_FAILED");
  }
  try {
    return await response.body.json();
  } catch {
    throw new CloudflareTurnCredentialError("CREDENTIAL_RESPONSE_INVALID");
  }
}

function createTurnCredentialUrl(input: {
  readonly nodeId: string;
  readonly nowEpochMs: number;
  readonly secret: string;
  readonly workerBaseUrl: string;
}): string {
  const url = new URL(input.workerBaseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CloudflareTurnCredentialError("CREDENTIAL_REQUEST_FAILED");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/turn/${input.nodeId}`;
  url.search = "";
  url.searchParams.set("token", createControlToken(input));
  return url.toString();
}

function createControlToken(input: {
  readonly nodeId: string;
  readonly nowEpochMs: number;
  readonly secret: string;
}): string {
  const payload = controlTokenPayloadSchema.parse({
    expiresAtEpochMs: input.nowEpochMs + 300_000,
    nodeId: input.nodeId,
    role: "mac",
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", input.secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}
