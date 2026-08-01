import { z } from "zod";

import {
  categoryIdSchema,
  deviceIdSchema,
  materialIdSchema,
  projectIdSchema,
  projectUploadKeyIdSchema,
  uploadIdSchema,
  webRtcSessionIdSchema,
} from "./ids.js";
import { uploadStateSchema } from "./uploads.js";

export const decimalBytesSchema = z.string().regex(/^\d+$/);

export const createProjectTargetRequestSchema = z.object({
  categoryName: z.string().min(1),
  projectName: z.string().min(1),
});

export const createProjectTargetResponseSchema = z.object({
  categoryId: categoryIdSchema,
  projectId: projectIdSchema,
});

export const projectTargetSummarySchema =
  createProjectTargetResponseSchema.extend({
    categoryName: z.string().min(1),
    projectName: z.string().min(1),
  });

export const listProjectTargetsResponseSchema = z.array(
  projectTargetSummarySchema,
);

export const createProjectUploadKeyRequestSchema = z.object({
  directoryName: z.string().min(1),
  target: createProjectTargetResponseSchema,
});

export const projectUploadKeyResponseSchema = z.object({
  directoryName: z.string().min(1),
  keyId: projectUploadKeyIdSchema,
  state: z.enum(["active", "revoked"]),
  target: createProjectTargetResponseSchema,
});

export const createProjectUploadKeyResponseSchema = z.object({
  rawKey: z.string().min(1),
  uploadKey: projectUploadKeyResponseSchema,
});

export const createUploadRequestSchema = z.object({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSizeBytes: decimalBytesSchema,
  fileName: z.string().min(1),
  target: createProjectTargetResponseSchema,
});

export const createUploadResponseSchema = z.object({
  uploadId: uploadIdSchema,
});

export const createTransferSessionRequestSchema = z.object({
  deviceId: deviceIdSchema,
  uploadId: uploadIdSchema,
});

export const createTransferSessionResponseSchema = z.object({
  expiresAtEpochMs: z.number().int().positive(),
  mobileSignalingToken: z.string().min(1),
  sessionId: webRtcSessionIdSchema,
  transferGrant: z.string().min(1),
});

export const uploadSnapshotResponseSchema = z.object({
  ackEpoch: decimalBytesSchema,
  receivedBytes: decimalBytesSchema,
  state: uploadStateSchema,
  uploadId: uploadIdSchema,
});

export const storageStatusResponseSchema = z.object({
  availableBytes: decimalBytesSchema,
  reservedBytes: decimalBytesSchema,
});

export const completedMaterialResponseSchema = z.object({
  materialId: materialIdSchema,
  path: z.string(),
});

export const apiErrorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});
