import type { RuntimeSignalingConfig } from "./runtime-config.js";
import {
  createMacControlRoute,
  type MacControlRoute,
} from "./transfers/mac-control-route.js";
import {
  createProjectUploadKeyControl,
  type ProjectUploadKeyControl,
} from "./transfers/project-upload-key-control.js";
import type { UploadTransferService } from "./transfers/upload-transfer-service.js";
import type { MaterialLibrary } from "./uploads/material-library.js";

export interface RuntimeProjectUploadControl {
  stop(): void;
}

/** Connects the local Key authority to the Worker only when remote upload is configured. */
export function createRuntimeProjectUploadControl(input: {
  readonly materialLibrary: MaterialLibrary;
  readonly onError: (error: Error) => void;
  readonly signaling: RuntimeSignalingConfig;
  readonly transferService?: UploadTransferService;
}): RuntimeProjectUploadControl | undefined {
  if (
    input.signaling.kind === "disabled" ||
    input.transferService === undefined
  ) {
    return undefined;
  }
  let control: ProjectUploadKeyControl | undefined;
  const route: MacControlRoute = createMacControlRoute({
    connectTimeoutMs: input.signaling.connectTimeoutMs,
    nodeId: input.signaling.nodeId,
    nowEpochMs: () => Date.now(),
    onError: input.onError,
    onRequest: (request) => {
      void control?.receive(request);
    },
    secret: input.signaling.signalingSecret,
    workerBaseUrl: input.signaling.workerBaseUrl,
  });
  control = createProjectUploadKeyControl({
    materialLibrary: input.materialLibrary,
    onError: input.onError,
    send: (response) => route.send(response),
    transferService: input.transferService,
  });
  route.start();
  return { stop: () => route.stop() };
}
