import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IceServerDescriptor } from "@jianying/contracts";
import { z } from "zod";

const DEFAULT_SIGNALING_WORKER_URL = "https://upload.lene.fun";
const DEFAULT_STUN_URLS = "stun:stun.cloudflare.com:3478";
const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 86_400;

const runtimeEnvironmentSchema = z.object({
  JIANYING_DATA_DIRECTORY: z.string().min(1).optional(),
  JIANYING_SIGNALING_HMAC_SECRET: z.string().min(32).optional(),
  JIANYING_SIGNALING_WORKER_URL: z.url().optional(),
  JIANYING_SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  JIANYING_STUN_URLS: z.string().min(1).optional(),
  JIANYING_TURN_API_TOKEN: z.string().min(1).optional(),
  JIANYING_TURN_CREDENTIAL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .optional(),
  JIANYING_TURN_KEY_ID: z.string().min(1).optional(),
});

export type CloudflareTurnRuntimeConfig = {
  readonly ttlSeconds: number;
};

export type RuntimeSignalingConfig =
  | { readonly kind: "disabled" }
  | {
      readonly baseIceServers: readonly IceServerDescriptor[];
      readonly connectTimeoutMs: number;
      readonly kind: "enabled";
      readonly nodeId: string;
      readonly signalingSecret: string;
      readonly tokenLifetimeMs: number;
      readonly turn: CloudflareTurnRuntimeConfig | undefined;
      readonly workerBaseUrl: string;
    };

export const RUNTIME_CONFIG_ERROR_REASONS = {
  SIGNALING_CONFIGURATION_INCOMPLETE: "SIGNALING_CONFIGURATION_INCOMPLETE",
  STUN_CONFIGURATION_INVALID: "STUN_CONFIGURATION_INVALID",
  TURN_LOCAL_CREDENTIALS_UNSUPPORTED: "TURN_LOCAL_CREDENTIALS_UNSUPPORTED",
} as const;

export type RuntimeConfigErrorReason =
  (typeof RUNTIME_CONFIG_ERROR_REASONS)[keyof typeof RUNTIME_CONFIG_ERROR_REASONS];

export class RuntimeConfigError extends Error {
  readonly name = "RuntimeConfigError";

  constructor(readonly reason: RuntimeConfigErrorReason) {
    super(`Runtime configuration failed: ${reason}`);
  }
}

export type RuntimeConfig = {
  readonly databasePath: string;
  readonly host: "127.0.0.1";
  readonly materialRootPath: string;
  readonly port: number;
  readonly signaling: RuntimeSignalingConfig;
};

/** Reads environment overrides once so application code never consumes raw environment variables. */
export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): RuntimeConfig {
  const parsed = runtimeEnvironmentSchema.parse(environment);
  const dataDirectory =
    parsed.JIANYING_DATA_DIRECTORY ??
    join(homedir(), "Library", "Application Support", "JianyingAutoEditor");

  return {
    databasePath: join(dataDirectory, "state.sqlite"),
    host: "127.0.0.1",
    materialRootPath: join(dataDirectory, "materials"),
    port: parsed.JIANYING_SERVER_PORT ?? 31_887,
    signaling: resolveSignalingConfig(parsed),
  };
}

function resolveSignalingConfig(input: {
  readonly JIANYING_SIGNALING_HMAC_SECRET?: string | undefined;
  readonly JIANYING_SIGNALING_WORKER_URL?: string | undefined;
  readonly JIANYING_STUN_URLS?: string | undefined;
  readonly JIANYING_TURN_API_TOKEN?: string | undefined;
  readonly JIANYING_TURN_CREDENTIAL_TTL_SECONDS?: number | undefined;
  readonly JIANYING_TURN_KEY_ID?: string | undefined;
}): RuntimeSignalingConfig {
  const workerBaseUrl =
    input.JIANYING_SIGNALING_WORKER_URL ??
    (input.JIANYING_SIGNALING_HMAC_SECRET === undefined
      ? undefined
      : DEFAULT_SIGNALING_WORKER_URL);
  const stunUrls =
    input.JIANYING_STUN_URLS ??
    (input.JIANYING_SIGNALING_HMAC_SECRET === undefined
      ? undefined
      : DEFAULT_STUN_URLS);
  const signalingValues = [
    input.JIANYING_SIGNALING_HMAC_SECRET,
    workerBaseUrl,
    stunUrls,
  ];
  const hasSignalingConfiguration = signalingValues.some(
    (value) => value !== undefined,
  );
  const hasTurnConfiguration =
    input.JIANYING_TURN_API_TOKEN !== undefined ||
    input.JIANYING_TURN_KEY_ID !== undefined ||
    input.JIANYING_TURN_CREDENTIAL_TTL_SECONDS !== undefined;
  if (!hasSignalingConfiguration && !hasTurnConfiguration) {
    return { kind: "disabled" };
  }
  if (signalingValues.some((value) => value === undefined)) {
    throw new RuntimeConfigError("SIGNALING_CONFIGURATION_INCOMPLETE");
  }
  const signalingSecret = input.JIANYING_SIGNALING_HMAC_SECRET;
  if (
    workerBaseUrl === undefined ||
    signalingSecret === undefined ||
    stunUrls === undefined
  ) {
    throw new RuntimeConfigError("SIGNALING_CONFIGURATION_INCOMPLETE");
  }
  const stunServerUrls = stunUrls
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (
    stunServerUrls.length === 0 ||
    stunServerUrls.some((url) => !/^stun:/i.test(url))
  ) {
    throw new RuntimeConfigError("STUN_CONFIGURATION_INVALID");
  }
  return {
    baseIceServers: [{ urls: stunServerUrls }],
    connectTimeoutMs: 10_000,
    kind: "enabled",
    nodeId: createNodeId(signalingSecret),
    signalingSecret,
    tokenLifetimeMs: 300_000,
    turn: resolveTurnConfig(input, signalingSecret !== undefined),
    workerBaseUrl,
  };
}

function resolveTurnConfig(
  input: {
    readonly JIANYING_TURN_API_TOKEN?: string | undefined;
    readonly JIANYING_TURN_CREDENTIAL_TTL_SECONDS?: number | undefined;
    readonly JIANYING_TURN_KEY_ID?: string | undefined;
  },
  useDeployedDefault: boolean,
): CloudflareTurnRuntimeConfig | undefined {
  if (
    input.JIANYING_TURN_API_TOKEN !== undefined ||
    input.JIANYING_TURN_KEY_ID !== undefined
  ) {
    throw new RuntimeConfigError("TURN_LOCAL_CREDENTIALS_UNSUPPORTED");
  }
  const ttlSeconds =
    input.JIANYING_TURN_CREDENTIAL_TTL_SECONDS ??
    (useDeployedDefault ? DEFAULT_TURN_CREDENTIAL_TTL_SECONDS : undefined);
  if (ttlSeconds === undefined) {
    return undefined;
  }
  return {
    ttlSeconds,
  };
}

function createNodeId(signalingSecret: string): string {
  return createHmac("sha256", signalingSecret)
    .update("jianying-project-upload-node-v1", "utf8")
    .digest("base64url")
    .slice(0, 22);
}
