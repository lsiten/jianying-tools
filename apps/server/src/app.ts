import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  apiErrorResponseSchema,
  createProjectTargetRequestSchema,
  createProjectTargetResponseSchema,
  createProjectUploadKeyRequestSchema,
  createProjectUploadKeyResponseSchema,
  createTransferSessionRequestSchema,
  createTransferSessionResponseSchema,
  createUploadRequestSchema,
  createUploadResponseSchema,
  listProjectTargetsResponseSchema,
  storageStatusResponseSchema,
  uploadIdSchema,
  uploadSnapshotResponseSchema,
} from "@jianying/contracts";
import { cors } from "hono/cors";
import { UploadSessionCoordinatorError } from "./transfers/upload-session-coordinator.js";
import type { UploadTransferService } from "./transfers/upload-transfer-service.js";
import type { MaterialLibrary } from "./uploads/material-library.js";
import { ProjectUploadKeyError } from "./uploads/project-upload-key-error.js";
import {
  StorageReservationError,
  UploadNotFoundError,
} from "./uploads/upload-errors.js";

const healthResponseSchema = z.object({ status: z.literal("ok") });

class AppErrorMappingError extends Error {
  readonly name = "AppErrorMappingError";

  constructor() {
    super("Unexpected upload session coordinator error");
  }
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: {
      content: { "application/json": { schema: healthResponseSchema } },
      description: "The local service is accepting requests.",
    },
  },
});

const createProjectTargetRoute = createRoute({
  method: "post",
  path: "/api/v1/project-targets",
  request: {
    body: {
      content: {
        "application/json": { schema: createProjectTargetRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: createProjectTargetResponseSchema },
      },
      description: "The project and material category target was created.",
    },
  },
});

const listProjectTargetsRoute = createRoute({
  method: "get",
  path: "/api/v1/project-targets",
  responses: {
    200: {
      content: {
        "application/json": { schema: listProjectTargetsResponseSchema },
      },
      description: "The persisted project/category targets for this Mac.",
    },
  },
});

const createProjectUploadKeyRoute = createRoute({
  method: "post",
  path: "/api/v1/project-upload-keys",
  request: {
    body: {
      content: {
        "application/json": { schema: createProjectUploadKeyRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: createProjectUploadKeyResponseSchema },
      },
      description:
        "The one-time project upload Key and its directory-scoped target.",
    },
    503: {
      content: { "application/json": { schema: apiErrorResponseSchema } },
      description: "Project upload Keys require local signaling configuration.",
    },
  },
});

const createUploadRoute = createRoute({
  method: "post",
  path: "/api/v1/uploads",
  request: {
    body: {
      content: { "application/json": { schema: createUploadRequestSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: createUploadResponseSchema } },
      description: "A locally durable upload session was created.",
    },
  },
});

const uploadSnapshotRoute = createRoute({
  method: "get",
  path: "/api/v1/uploads/{uploadId}",
  request: { params: z.object({ uploadId: uploadIdSchema }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: uploadSnapshotResponseSchema },
      },
      description: "The durable upload acknowledgement state.",
    },
  },
});

const storageStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/storage-status",
  responses: {
    200: {
      content: {
        "application/json": { schema: storageStatusResponseSchema },
      },
      description: "Available and reserved capacity on the material volume.",
    },
  },
});

const createTransferSessionRoute = createRoute({
  method: "post",
  path: "/api/v1/transfer-sessions",
  request: {
    body: {
      content: {
        "application/json": { schema: createTransferSessionRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: createTransferSessionResponseSchema },
      },
      description:
        "The mobile transfer capability after the Mac signaling route is connected.",
    },
    503: {
      content: { "application/json": { schema: apiErrorResponseSchema } },
      description:
        "External signaling is not configured for this local server.",
    },
  },
});

export type AppDependencies = {
  readonly materialLibrary: MaterialLibrary;
  readonly transferService?: UploadTransferService;
};

/** Creates the local HTTP control plane; media bytes deliberately stay off HTTP. */
export function createApp(dependencies: AppDependencies): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (result.success) {
        return;
      }
      return context.json(
        { code: "INVALID_REQUEST", message: "Request validation failed" },
        400,
      );
    },
  });
  app.use(
    "*",
    cors({
      allowHeaders: ["content-type"],
      allowMethods: ["GET", "POST"],
      origin: allowedControlPlaneOrigin,
    }),
  );

  app.openapi(healthRoute, (context) => context.json({ status: "ok" }, 200));

  app.openapi(createProjectTargetRoute, (context) => {
    const input = context.req.valid("json");
    const target = dependencies.materialLibrary.createProjectTarget(input);
    return context.json(target, 201);
  });

  app.openapi(listProjectTargetsRoute, (context) =>
    context.json([...dependencies.materialLibrary.listProjectTargets()], 200),
  );

  app.openapi(createProjectUploadKeyRoute, (context) => {
    const input = context.req.valid("json");
    const created = dependencies.materialLibrary.createProjectUploadKey(input);
    return context.json(created, 201);
  });

  app.openapi(createUploadRoute, async (context) => {
    const input = context.req.valid("json");
    const upload = await dependencies.materialLibrary.createUpload({
      expectedSha256: input.expectedSha256,
      expectedSizeBytes: BigInt(input.expectedSizeBytes),
      fileName: input.fileName,
      target: input.target,
    });
    return context.json(upload, 201);
  });

  app.openapi(uploadSnapshotRoute, (context) => {
    const { uploadId } = context.req.valid("param");
    const snapshot = dependencies.materialLibrary.getUpload(uploadId);
    return context.json(
      {
        ackEpoch: snapshot.ackEpoch.toString(),
        receivedBytes: snapshot.receivedBytes.toString(),
        state: snapshot.state,
        uploadId: snapshot.uploadId,
      },
      200,
    );
  });

  app.openapi(storageStatusRoute, async (context) => {
    const storage = await dependencies.materialLibrary.storageStatus();
    return context.json(
      {
        availableBytes: storage.availableBytes.toString(),
        reservedBytes: storage.reservedBytes.toString(),
      },
      200,
    );
  });

  app.openapi(createTransferSessionRoute, async (context) => {
    if (dependencies.transferService === undefined) {
      return context.json(
        {
          code: "TRANSFER_SERVICE_UNAVAILABLE",
          message: "External signaling is not configured for this local server",
        },
        503,
      );
    }
    const input = context.req.valid("json");
    const created = await dependencies.transferService.create(input);
    return context.json(
      {
        expiresAtEpochMs: created.expiresAtEpochMs,
        mobileSignalingToken: created.mobileSignalingToken,
        sessionId: created.sessionId,
        transferGrant: created.transferGrant,
      },
      201,
    );
  });

  app.doc("/openapi.json", {
    info: { title: "本机智能剪辑 API", version: "0.1.0" },
    openapi: "3.1.0",
  });
  app.onError((error, context) => {
    if (error instanceof ProjectUploadKeyError) {
      switch (error.reason) {
        case "PROJECT_UPLOAD_KEY_UNAVAILABLE":
          return context.json(
            {
              code: error.reason,
              message:
                "Project upload Keys require configured external signaling",
            },
            503,
          );
        case "DEVICE_PUBLIC_KEY_MISMATCH":
        case "PROJECT_UPLOAD_KEY_INVALID":
        case "PROJECT_UPLOAD_KEY_REVOKED":
        case "PROJECT_UPLOAD_KEY_UNAUTHORIZED":
          return context.json(
            {
              code: error.reason,
              message: "The project upload Key was rejected",
            },
            403,
          );
        default:
          return assertNever(error.reason);
      }
    }
    if (error instanceof UploadSessionCoordinatorError) {
      switch (error.reason) {
        case "DEVICE_NOT_PAIRED":
          return context.json(
            {
              code: error.reason,
              message: "The requested mobile device is not paired",
            },
            403,
          );
        case "UPLOAD_NOT_TRANSFERABLE":
          return context.json(
            {
              code: error.reason,
              message: "The upload is not available for transfer",
            },
            409,
          );
        case "INVALID_TOKEN_LIFETIME":
        case "OUTBOUND_SIGNAL_DELIVERY_FAILED":
        case "TOKEN_EXPIRY_OVERFLOW":
        case "UNSUPPORTED_LOCAL_DESCRIPTION":
          return context.json(
            {
              code: error.reason,
              message: "The transfer session could not start",
            },
            500,
          );
        default:
          return assertNever(error.reason);
      }
    }
    if (error instanceof StorageReservationError) {
      return context.json(
        {
          code: "STORAGE_RESERVATION_UNAVAILABLE",
          message:
            "The selected local material storage cannot reserve this upload",
        },
        409,
      );
    }
    if (error instanceof UploadNotFoundError) {
      return context.json(
        { code: "UPLOAD_NOT_FOUND", message: "The upload does not exist" },
        404,
      );
    }
    return context.json(
      { code: "INTERNAL_ERROR", message: "The local service failed" },
      500,
    );
  });
  return app;
}

export { apiErrorResponseSchema };

function assertNever(_value: never): never {
  throw new AppErrorMappingError();
}

function allowedControlPlaneOrigin(origin: string): string | undefined {
  if (
    origin === "tauri://localhost" ||
    origin === "http://tauri.localhost" ||
    origin === "https://tauri.localhost"
  ) {
    return origin;
  }
  try {
    const candidate = new URL(origin);
    if (
      candidate.protocol === "http:" &&
      (candidate.hostname === "127.0.0.1" ||
        candidate.hostname === "localhost" ||
        candidate.hostname === "[::1]")
    ) {
      return origin;
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
  return undefined;
}
