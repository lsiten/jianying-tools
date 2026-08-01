import {
  createProjectUploadKeyResponseSchema,
  storageStatusResponseSchema,
} from "@jianying/contracts";
import { z } from "zod";

const healthSchema = z.object({ status: z.literal("ok") });

const projectTargetSchema = z.object({
  categoryId: z.string().uuid(),
  projectId: z.string().uuid(),
});

const projectTargetSummarySchema = projectTargetSchema.extend({
  categoryName: z.string().min(1),
  projectName: z.string().min(1),
});

const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type ProjectTarget = z.infer<typeof projectTargetSchema>;
export type ProjectTargetSummary = z.infer<typeof projectTargetSummarySchema>;
export type CreatedProjectUploadKey = z.infer<
  typeof createProjectUploadKeyResponseSchema
>;
export type StorageStatus = z.infer<typeof storageStatusResponseSchema>;

export const CONTROL_PLANE_ERROR_REASONS = {
  LOCAL_ENDPOINT_REQUIRED: "LOCAL_ENDPOINT_REQUIRED",
  NETWORK_UNAVAILABLE: "NETWORK_UNAVAILABLE",
  RESPONSE_INVALID: "RESPONSE_INVALID",
  REQUEST_REJECTED: "REQUEST_REJECTED",
} as const;

export type ControlPlaneErrorReason =
  (typeof CONTROL_PLANE_ERROR_REASONS)[keyof typeof CONTROL_PLANE_ERROR_REASONS];

export class ControlPlaneError extends Error {
  readonly name = "ControlPlaneError";

  constructor(
    readonly reason: ControlPlaneErrorReason,
    readonly messageForUser: string,
  ) {
    super(`Local control plane request failed: ${reason}`);
  }
}

export type ControlPlaneApi = {
  createProjectUploadKey(
    input: CreateProjectUploadKeyInput,
  ): Promise<CreatedProjectUploadKey>;
  createProjectTarget(input: CreateProjectTargetInput): Promise<ProjectTarget>;
  health(signal?: AbortSignal): Promise<void>;
  listProjectTargets(): Promise<readonly ProjectTargetSummary[]>;
  storageStatus(): Promise<StorageStatus>;
};

export type CreateProjectTargetInput = {
  readonly categoryName: string;
  readonly projectName: string;
};

export type CreateProjectUploadKeyInput = {
  readonly directoryName: string;
  readonly target: ProjectTarget;
};

/** Creates a small typed client for the Mac-local HTTP control plane. */
export function createControlPlaneApi(baseUrl: string): ControlPlaneApi {
  const endpoint = parseBaseUrl(baseUrl);
  return {
    async createProjectUploadKey(input) {
      const response = await request(endpoint, "/api/v1/project-upload-keys", {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return parseSuccess(response, createProjectUploadKeyResponseSchema);
    },
    async createProjectTarget(input) {
      const response = await request(endpoint, "/api/v1/project-targets", {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return parseSuccess(response, projectTargetSchema);
    },
    async health(signal) {
      const response = await request(
        endpoint,
        "/health",
        signal === undefined ? {} : { signal },
      );
      parseSuccess(response, healthSchema);
    },
    async listProjectTargets() {
      const response = await request(endpoint, "/api/v1/project-targets", {
        method: "GET",
      });
      return parseSuccess(response, z.array(projectTargetSummarySchema));
    },
    async storageStatus() {
      const response = await request(endpoint, "/api/v1/storage-status", {
        method: "GET",
      });
      return parseSuccess(response, storageStatusResponseSchema);
    },
  };
}

function parseBaseUrl(baseUrl: string): URL {
  try {
    const endpoint = new URL(baseUrl);
    if (endpoint.protocol !== "http:" || !isLoopbackHost(endpoint.hostname)) {
      throw new ControlPlaneError(
        "LOCAL_ENDPOINT_REQUIRED",
        "本机服务地址只能使用 Mac 上的 HTTP 回环地址。",
      );
    }
    return endpoint;
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new ControlPlaneError(
        "NETWORK_UNAVAILABLE",
        "本机服务地址无效，请检查地址后重试。",
      );
    }
    throw error;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}

async function request(
  baseUrl: URL,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const target = new URL(path, baseUrl);
  try {
    return await fetch(target, init);
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) {
      throw new ControlPlaneError(
        "NETWORK_UNAVAILABLE",
        "无法连接本机服务。请确认 Mac 上的服务已启动且地址正确。",
      );
    }
    throw error;
  }
}

async function parseSuccess<TSchema extends z.ZodType>(
  response: Response,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  const payload = await readJson(response);
  if (!response.ok) {
    const apiError = apiErrorSchema.safeParse(payload);
    throw new ControlPlaneError(
      "REQUEST_REJECTED",
      apiError.success ? apiError.data.message : "本机服务拒绝了此次请求。",
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ControlPlaneError(
      "RESPONSE_INVALID",
      "本机服务返回的数据格式无效，请检查本机应用版本。",
    );
  }
  return parsed.data;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}
