import { z } from "zod";

const uuid = z.string().uuid();

export const categoryIdSchema = uuid.brand<"CategoryId">();
export const deviceIdSchema = uuid.brand<"DeviceId">();
export const materialIdSchema = uuid.brand<"MaterialId">();
export const projectIdSchema = uuid.brand<"ProjectId">();
export const projectUploadKeyIdSchema = uuid.brand<"ProjectUploadKeyId">();
export const uploadIdSchema = uuid.brand<"UploadId">();
export const webRtcSessionIdSchema = uuid.brand<"WebRtcSessionId">();

export type CategoryId = z.infer<typeof categoryIdSchema>;
export type DeviceId = z.infer<typeof deviceIdSchema>;
export type MaterialId = z.infer<typeof materialIdSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
export type ProjectUploadKeyId = z.infer<typeof projectUploadKeyIdSchema>;
export type UploadId = z.infer<typeof uploadIdSchema>;
export type WebRtcSessionId = z.infer<typeof webRtcSessionIdSchema>;
