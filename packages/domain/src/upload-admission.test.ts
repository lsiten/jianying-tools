import { describe, expect, test } from "vitest";

import { assessUploadAdmission } from "./upload-admission.js";

describe("upload admission", () => {
  test("accepts a large file when real capacity covers its reservation", () => {
    // Given: a file well beyond any historical product cap and enough storage.
    const fileBytes = 9_999_999_999_999n;

    // When: the service evaluates the actual capacity reservation.
    const result = assessUploadAdmission({
      availableBytes: fileBytes + 1n,
      fileBytes,
      reservedBytes: 0n,
    });

    // Then: no business size threshold rejects the upload.
    expect(result).toEqual({
      kind: "accepted",
      reservationBytes: fileBytes,
    });
  });

  test("rejects only when the real storage reservation is unavailable", () => {
    // Given: capacity is one byte below the requested reservation.
    const fileBytes = 9_999_999_999_999n;

    // When: the service evaluates the actual capacity reservation.
    const result = assessUploadAdmission({
      availableBytes: fileBytes - 1n,
      fileBytes,
      reservedBytes: 0n,
    });

    // Then: the client receives a storage-specific outcome.
    expect(result).toEqual({
      kind: "rejected",
      reason: "STORAGE_RESERVATION_UNAVAILABLE",
    });
  });
});
