export const UPLOAD_REJECTION_REASONS = {
  STORAGE_RESERVATION_UNAVAILABLE: "STORAGE_RESERVATION_UNAVAILABLE",
} as const;

export type UploadRejectionReason =
  (typeof UPLOAD_REJECTION_REASONS)[keyof typeof UPLOAD_REJECTION_REASONS];

export type UploadAdmissionRequest = {
  readonly availableBytes: bigint;
  readonly fileBytes: bigint;
  readonly reservedBytes: bigint;
};

export type UploadAdmission =
  | { readonly kind: "accepted"; readonly reservationBytes: bigint }
  | { readonly kind: "rejected"; readonly reason: UploadRejectionReason };

/** Applies real capacity reservation without a file-size, batch-size, or file-count cap. */
export function assessUploadAdmission(
  request: UploadAdmissionRequest,
): UploadAdmission {
  const usableBytes = request.availableBytes - request.reservedBytes;

  if (usableBytes < request.fileBytes) {
    return {
      kind: "rejected",
      reason: UPLOAD_REJECTION_REASONS.STORAGE_RESERVATION_UNAVAILABLE,
    };
  }

  return {
    kind: "accepted",
    reservationBytes: request.fileBytes,
  };
}
