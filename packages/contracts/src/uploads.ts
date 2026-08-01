import { z } from "zod";

export const uploadStateSchema = z.enum([
  "transferring",
  "cancelled",
  "staged",
  "hash_verified",
  "committed",
  "ready",
  "recoverable_error",
]);

export type UploadState = z.infer<typeof uploadStateSchema>;
