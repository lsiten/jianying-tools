import { z } from "zod";

import {
  categoryIdSchema,
  deviceIdSchema,
  projectIdSchema,
  projectUploadKeyIdSchema,
  uploadIdSchema,
  webRtcSessionIdSchema,
} from "./ids.js";

export const controlNodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

const projectTargetSchema = z
  .object({ categoryId: categoryIdSchema, projectId: projectIdSchema })
  .strict();

const requestIdSchema = z.string().uuid();
const expectedSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const decimalBytesSchema = z.string().regex(/^\d+$/);
const iceServerUrlSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(stun|turn|turns):/i);

/** Browser-compatible ICE server settings. Relay credentials are always short-lived. */
export const iceServerDescriptorSchema = z
  .object({
    credential: z.string().min(1).optional(),
    urls: z.array(iceServerUrlSchema).min(1),
    username: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((server, context) => {
    const hasRelayUrl = server.urls.some((url) => /^turns?:/i.test(url));
    const hasUsername = server.username !== undefined;
    const hasCredential = server.credential !== undefined;
    if (hasUsername !== hasCredential) {
      context.addIssue({
        code: "custom",
        message: "TURN username and credential must be supplied together",
        path: hasUsername ? ["credential"] : ["username"],
      });
    }
    if (hasRelayUrl && (!hasUsername || !hasCredential)) {
      context.addIssue({
        code: "custom",
        message: "TURN servers require short-lived credentials",
        path: ["urls"],
      });
    }
    if (!hasRelayUrl && (hasUsername || hasCredential)) {
      context.addIssue({
        code: "custom",
        message: "Non-relay servers must not include relay credentials",
        path: ["urls"],
      });
    }
  });

export type IceServerDescriptor = z.infer<typeof iceServerDescriptorSchema>;

export const REMOTE_CONTROL_MESSAGE_TYPES = {
  PROJECT_UPLOAD_KEY_REDEEM_ACCEPTED: "project_upload_key_redeem_accepted",
  PROJECT_UPLOAD_KEY_REDEEM_REJECTED: "project_upload_key_redeem_rejected",
  PROJECT_UPLOAD_KEY_REDEEM_REQUEST: "project_upload_key_redeem_request",
  PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED:
    "project_upload_transfer_create_accepted",
  PROJECT_UPLOAD_TRANSFER_CREATE_REJECTED:
    "project_upload_transfer_create_rejected",
  PROJECT_UPLOAD_TRANSFER_CREATE_REQUEST:
    "project_upload_transfer_create_request",
  PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED:
    "project_upload_transfer_resume_accepted",
  PROJECT_UPLOAD_TRANSFER_RESUME_REJECTED:
    "project_upload_transfer_resume_rejected",
  PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST:
    "project_upload_transfer_resume_request",
} as const;

export const remoteControlMobileRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      deviceId: deviceIdSchema,
      displayName: z.string().trim().min(1).max(96),
      publicKeySpkiBase64Url: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(1024),
      rawKey: z.string().min(1).max(256),
      requestId: requestIdSchema,
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REQUEST,
      ),
    })
    .strict(),
  z
    .object({
      deviceId: deviceIdSchema,
      expectedSha256: expectedSha256Schema,
      expectedSizeBytes: decimalBytesSchema,
      fileName: z.string().trim().min(1).max(255),
      keyId: projectUploadKeyIdSchema,
      requestId: requestIdSchema,
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REQUEST,
      ),
    })
    .strict(),
  z
    .object({
      deviceId: deviceIdSchema,
      expectedSha256: expectedSha256Schema,
      expectedSizeBytes: decimalBytesSchema,
      fileName: z.string().trim().min(1).max(255),
      keyId: projectUploadKeyIdSchema,
      requestId: requestIdSchema,
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST,
      ),
      uploadId: uploadIdSchema,
    })
    .strict(),
]);

export const remoteControlMacResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      directoryName: z.string().min(1),
      keyId: projectUploadKeyIdSchema,
      requestId: requestIdSchema,
      target: projectTargetSchema,
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_ACCEPTED,
      ),
    })
    .strict(),
  z
    .object({
      expiresAtEpochMs: z.number().int().positive(),
      iceServers: z.array(iceServerDescriptorSchema).min(1),
      maxChunkBytes: z.number().int().positive(),
      mobileSignalingToken: z.string().min(1),
      requestId: requestIdSchema,
      sessionId: webRtcSessionIdSchema,
      transferGrant: z.string().min(1),
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED,
      ),
      uploadId: uploadIdSchema,
    })
    .strict(),
  z
    .object({
      reason: z.literal("PROJECT_UPLOAD_KEY_REJECTED"),
      requestId: requestIdSchema,
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REJECTED,
      ),
    })
    .strict(),
  z
    .object({
      expiresAtEpochMs: z.number().int().positive(),
      iceServers: z.array(iceServerDescriptorSchema).min(1),
      maxChunkBytes: z.number().int().positive(),
      mobileSignalingToken: z.string().min(1),
      requestId: requestIdSchema,
      sessionId: webRtcSessionIdSchema,
      transferGrant: z.string().min(1),
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED,
      ),
      uploadId: uploadIdSchema,
    })
    .strict(),
  z
    .object({
      code: z.enum([
        "PROJECT_UPLOAD_KEY_REJECTED",
        "STORAGE_RESERVATION_UNAVAILABLE",
        "TRANSFER_SERVICE_UNAVAILABLE",
      ]),
      requestId: requestIdSchema,
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REJECTED,
      ),
    })
    .strict(),
  z
    .object({
      code: z.enum([
        "PROJECT_UPLOAD_KEY_REJECTED",
        "TRANSFER_NOT_RESUMABLE",
        "TRANSFER_SERVICE_UNAVAILABLE",
      ]),
      requestId: requestIdSchema,
      type: z.literal(
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REJECTED,
      ),
    })
    .strict(),
]);

export const remoteControlMessageSchema = z.union([
  remoteControlMobileRequestSchema,
  remoteControlMacResponseSchema,
]);

export const controlTokenPayloadSchema = z
  .object({
    expiresAtEpochMs: z.number().int().positive(),
    nodeId: controlNodeIdSchema,
    role: z.literal("mac"),
  })
  .strict();

export type ControlTokenPayload = z.infer<typeof controlTokenPayloadSchema>;
export type RemoteControlMacResponse = z.infer<
  typeof remoteControlMacResponseSchema
>;
export type RemoteControlMessage = z.infer<typeof remoteControlMessageSchema>;
export type RemoteControlMobileRequest = z.infer<
  typeof remoteControlMobileRequestSchema
>;
