import { serve } from "@hono/node-server";
import pino from "pino";

import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { resolveRuntimeEnvironment } from "./runtime-environment.js";
import { createRuntimeProjectUploadControl } from "./runtime-project-upload-control.js";
import { createRuntimeTransferService } from "./runtime-transfer-service.js";
import { availableStorageBytes } from "./uploads/material-layout.js";
import { createMaterialLibrary } from "./uploads/material-library.js";

const runtimeEnvironment = await resolveRuntimeEnvironment({
  environment: process.env,
});
const config = loadRuntimeConfig(runtimeEnvironment);
const logger = pino({ name: "jianying-auto-editor" });
const materialLibrary = await createMaterialLibrary({
  availableBytes: async () => availableStorageBytes(config.materialRootPath),
  databasePath: config.databasePath,
  materialRootPath: config.materialRootPath,
  ...(config.signaling.kind === "enabled"
    ? {
        projectUploadKeyPepper: config.signaling.signalingSecret,
        projectUploadNodeId: config.signaling.nodeId,
      }
    : {}),
});
const transferService =
  config.signaling.kind === "enabled"
    ? createRuntimeTransferService({
        materialLibrary,
        onError: (error) => logger.error({ error }, "Transfer service failed"),
        signaling: config.signaling,
      })
    : createRuntimeTransferService({
        onError: (error) => logger.error({ error }, "Transfer service failed"),
        signaling: config.signaling,
      });
const projectUploadControl = createRuntimeProjectUploadControl({
  materialLibrary,
  onError: (error) => logger.error({ error }, "Project upload control failed"),
  signaling: config.signaling,
  ...(transferService === undefined ? {} : { transferService }),
});
const app = createApp(
  transferService === undefined
    ? { materialLibrary }
    : { materialLibrary, transferService },
);

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (address) => {
    logger.info(
      { host: config.host, port: address.port },
      "Local control plane is listening",
    );
  },
);

let stopping = false;

function stop(signal: "SIGINT" | "SIGTERM"): void {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ signal }, "Stopping local control plane");
  server.close((error) => {
    projectUploadControl?.stop();
    materialLibrary.close();
    if (error !== undefined) {
      logger.error({ error }, "The local control plane stopped with an error");
      process.exitCode = 1;
      return;
    }
    logger.info("Local control plane stopped");
  });
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
