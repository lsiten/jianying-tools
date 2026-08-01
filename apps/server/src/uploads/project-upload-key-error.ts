export const PROJECT_UPLOAD_KEY_ERROR_REASONS = {
  DEVICE_PUBLIC_KEY_MISMATCH: "DEVICE_PUBLIC_KEY_MISMATCH",
  PROJECT_UPLOAD_KEY_INVALID: "PROJECT_UPLOAD_KEY_INVALID",
  PROJECT_UPLOAD_KEY_REVOKED: "PROJECT_UPLOAD_KEY_REVOKED",
  PROJECT_UPLOAD_KEY_UNAUTHORIZED: "PROJECT_UPLOAD_KEY_UNAUTHORIZED",
  PROJECT_UPLOAD_KEY_UNAVAILABLE: "PROJECT_UPLOAD_KEY_UNAVAILABLE",
} as const;

export type ProjectUploadKeyErrorReason =
  (typeof PROJECT_UPLOAD_KEY_ERROR_REASONS)[keyof typeof PROJECT_UPLOAD_KEY_ERROR_REASONS];

export class ProjectUploadKeyError extends Error {
  readonly name = "ProjectUploadKeyError";

  constructor(readonly reason: ProjectUploadKeyErrorReason) {
    super(`Project upload Key failed: ${reason}`);
  }
}
