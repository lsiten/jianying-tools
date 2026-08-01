import type { RuntimeSignalingConfig } from "./runtime-config.js";
import { createCloudflareSignalingClient } from "./transfers/cloudflare-signaling-client.js";
import { createCloudflareWorkerTurnCredentialProvider } from "./transfers/cloudflare-worker-turn-credential-provider.js";
import { createSessionSignalingGateway } from "./transfers/session-signaling-gateway.js";
import {
  createUploadSessionCoordinator,
  type UploadSessionCoordinator,
} from "./transfers/upload-session-coordinator.js";
import {
  createUploadTransferService,
  type UploadTransferService,
} from "./transfers/upload-transfer-service.js";
import type { MaterialLibrary } from "./uploads/material-library.js";

const DEFAULT_MAX_CHUNK_BYTES = 1_048_576;

type DisabledRuntimeTransferServiceInput = {
  readonly onError: (error: Error) => void;
  readonly signaling: Extract<
    RuntimeSignalingConfig,
    { readonly kind: "disabled" }
  >;
};

type EnabledRuntimeTransferServiceInput = {
  readonly materialLibrary: MaterialLibrary;
  readonly onError: (error: Error) => void;
  readonly signaling: Extract<
    RuntimeSignalingConfig,
    { readonly kind: "enabled" }
  >;
};

/** Constructs public-transfer plumbing only for an explicitly configured local server. */
export function createRuntimeTransferService(
  input: DisabledRuntimeTransferServiceInput,
): undefined;
export function createRuntimeTransferService(
  input: EnabledRuntimeTransferServiceInput,
): UploadTransferService;
export function createRuntimeTransferService(
  input:
    | DisabledRuntimeTransferServiceInput
    | EnabledRuntimeTransferServiceInput,
): UploadTransferService | undefined {
  if (!isEnabledRuntimeTransferServiceInput(input)) {
    return undefined;
  }
  return createEnabledTransferService(input);
}

function createEnabledTransferService(
  input: EnabledRuntimeTransferServiceInput,
): UploadTransferService {
  const signalingClient = createCloudflareSignalingClient({
    connectTimeoutMs: input.signaling.connectTimeoutMs,
  });
  const gateway = createSessionSignalingGateway({
    signalingClient,
    workerBaseUrl: input.signaling.workerBaseUrl,
  });
  const coordinator: UploadSessionCoordinator = createUploadSessionCoordinator({
    materialLibrary: input.materialLibrary,
    maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
    nowEpochMs: () => Date.now(),
    onError: input.onError,
    onOutboundSignal: (message) => gateway.forwardOutbound(message),
    signalingSecret: input.signaling.signalingSecret,
    tokenLifetimeMs: input.signaling.tokenLifetimeMs,
  });
  return createUploadTransferService({
    coordinator,
    gateway,
    onError: input.onError,
    resolveIceServers: createIceServerResolver(input.signaling),
  });
}

function createIceServerResolver(
  signaling: Extract<RuntimeSignalingConfig, { readonly kind: "enabled" }>,
): () => Promise<readonly import("@jianying/contracts").IceServerDescriptor[]> {
  if (signaling.turn === undefined) {
    return async () => signaling.baseIceServers;
  }
  const provider = createCloudflareWorkerTurnCredentialProvider({
    nodeId: signaling.nodeId,
    secret: signaling.signalingSecret,
    ttlSeconds: signaling.turn.ttlSeconds,
    workerBaseUrl: signaling.workerBaseUrl,
  });
  return () => provider.resolveIceServers();
}

function isEnabledRuntimeTransferServiceInput(
  input:
    | DisabledRuntimeTransferServiceInput
    | EnabledRuntimeTransferServiceInput,
): input is EnabledRuntimeTransferServiceInput {
  return input.signaling.kind === "enabled";
}
