import {
  type IceServerDescriptor,
  iceServerDescriptorSchema,
} from "@jianying/contracts";
import { request } from "undici";
import { z } from "zod";

const cloudflareTurnResponseSchema = z
  .object({
    iceServers: z
      .array(
        z
          .object({
            credential: z.string().optional(),
            urls: z.array(z.string()),
            username: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export const CLOUDFLARE_TURN_CREDENTIAL_ERROR_REASONS = {
  CREDENTIAL_REQUEST_FAILED: "CREDENTIAL_REQUEST_FAILED",
  CREDENTIAL_RESPONSE_INVALID: "CREDENTIAL_RESPONSE_INVALID",
} as const;

export type CloudflareTurnCredentialErrorReason =
  (typeof CLOUDFLARE_TURN_CREDENTIAL_ERROR_REASONS)[keyof typeof CLOUDFLARE_TURN_CREDENTIAL_ERROR_REASONS];

export class CloudflareTurnCredentialError extends Error {
  readonly name = "CloudflareTurnCredentialError";

  constructor(readonly reason: CloudflareTurnCredentialErrorReason) {
    super(`Cloudflare TURN credential failed: ${reason}`);
  }
}

export type TurnCredentialRequester = (input: {
  readonly apiToken: string;
  readonly keyId: string;
  readonly ttlSeconds: number;
}) => Promise<unknown>;

export interface IceServerResolver {
  resolveIceServers(): Promise<readonly IceServerDescriptor[]>;
}

/** Mints a short-lived Cloudflare TURN credential for exactly one upload session. */
export function createCloudflareTurnCredentialProvider(input: {
  readonly apiToken: string;
  readonly keyId: string;
  readonly requestCredentials?: TurnCredentialRequester;
  readonly ttlSeconds: number;
}): IceServerResolver {
  const requestCredentials =
    input.requestCredentials ?? requestCloudflareTurnCredentials;
  return {
    async resolveIceServers(): Promise<readonly IceServerDescriptor[]> {
      let response: unknown;
      try {
        response = await requestCredentials({
          apiToken: input.apiToken,
          keyId: input.keyId,
          ttlSeconds: input.ttlSeconds,
        });
      } catch {
        throw new CloudflareTurnCredentialError("CREDENTIAL_REQUEST_FAILED");
      }
      return parseBrowserIceServers(response);
    },
  };
}

async function requestCloudflareTurnCredentials(input: {
  readonly apiToken: string;
  readonly keyId: string;
  readonly ttlSeconds: number;
}): Promise<unknown> {
  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(input.keyId)}/credentials/generate-ice-servers`;
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request(endpoint, {
      body: JSON.stringify({ ttl: input.ttlSeconds }),
      bodyTimeout: 10_000,
      headers: {
        authorization: `Bearer ${input.apiToken}`,
        "content-type": "application/json",
      },
      headersTimeout: 10_000,
      method: "POST",
    });
  } catch {
    throw new CloudflareTurnCredentialError("CREDENTIAL_REQUEST_FAILED");
  }
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

export function parseBrowserIceServers(
  value: unknown,
): readonly IceServerDescriptor[] {
  try {
    const response = cloudflareTurnResponseSchema.parse(value);
    const iceServers = response.iceServers
      .map((server) => ({
        ...(server.credential === undefined
          ? {}
          : { credential: server.credential }),
        urls: server.urls.filter(isBrowserSafeIceUrl),
        ...(server.username === undefined ? {} : { username: server.username }),
      }))
      .filter((server) => server.urls.length > 0)
      .map((server) => iceServerDescriptorSchema.parse(server));
    if (
      !iceServers.some((server) =>
        server.urls.some((url) => /^turns?:/i.test(url)),
      )
    ) {
      throw new Error("No usable TURN URLs");
    }
    return iceServers;
  } catch {
    throw new CloudflareTurnCredentialError("CREDENTIAL_RESPONSE_INVALID");
  }
}

function isBrowserSafeIceUrl(url: string): boolean {
  return !/^(stun|turn|turns):[^/?]+:53(?:[/?]|$)/i.test(url);
}
