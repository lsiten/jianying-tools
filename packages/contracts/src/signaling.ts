import { z } from "zod";

import { webRtcSessionIdSchema } from "./ids.js";

export const SIGNALING_MESSAGE_TYPES = {
  CANDIDATE: "candidate",
  CLOSE: "close",
  DESCRIPTION: "description",
} as const;

export const SIGNALING_CLOSE_REASONS = {
  CONNECTION_FAILED: "CONNECTION_FAILED",
  TRANSFER_CANCELLED: "TRANSFER_CANCELLED",
  TRANSFER_FINISHED: "TRANSFER_FINISHED",
} as const;

export const signalingRoleSchema = z.enum(["mac", "mobile"]);

export const signalingCloseReasonSchema = z.enum([
  SIGNALING_CLOSE_REASONS.CONNECTION_FAILED,
  SIGNALING_CLOSE_REASONS.TRANSFER_CANCELLED,
  SIGNALING_CLOSE_REASONS.TRANSFER_FINISHED,
]);

export const signalingMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      candidate: z.string().min(1),
      mid: z.string().min(1),
      sessionId: webRtcSessionIdSchema,
      type: z.literal(SIGNALING_MESSAGE_TYPES.CANDIDATE),
    })
    .strict(),
  z
    .object({
      descriptionType: z.enum(["offer", "answer"]),
      sdp: z.string().min(1),
      sessionId: webRtcSessionIdSchema,
      type: z.literal(SIGNALING_MESSAGE_TYPES.DESCRIPTION),
    })
    .strict(),
  z
    .object({
      reason: signalingCloseReasonSchema,
      sessionId: webRtcSessionIdSchema,
      type: z.literal(SIGNALING_MESSAGE_TYPES.CLOSE),
    })
    .strict(),
]);

export const signalingTokenPayloadSchema = z
  .object({
    expiresAtEpochMs: z.number().int().positive(),
    role: signalingRoleSchema,
    sessionId: webRtcSessionIdSchema,
  })
  .strict();

export type SignalingMessage = z.infer<typeof signalingMessageSchema>;
export type SignalingCloseReason = z.infer<typeof signalingCloseReasonSchema>;
export type SignalingRole = z.infer<typeof signalingRoleSchema>;
export type SignalingTokenPayload = z.infer<typeof signalingTokenPayloadSchema>;
