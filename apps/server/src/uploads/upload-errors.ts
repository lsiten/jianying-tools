import type { UploadId } from "@jianying/contracts";

export class StorageReservationError extends Error {
  readonly name = "StorageReservationError";

  constructor(readonly uploadBytes: bigint) {
    super(`Storage cannot reserve ${uploadBytes} bytes`);
  }
}

export class UploadIntegrityError extends Error {
  readonly name = "UploadIntegrityError";

  constructor(
    readonly uploadId: UploadId,
    readonly reason: string,
  ) {
    super(`${uploadId}: ${reason}`);
  }
}

export class UploadNotFoundError extends Error {
  readonly name = "UploadNotFoundError";

  constructor(readonly uploadId: UploadId) {
    super(`Upload does not exist: ${uploadId}`);
  }
}

export class UploadStateError extends Error {
  readonly name = "UploadStateError";

  constructor(
    readonly uploadId: UploadId,
    readonly state: string,
  ) {
    super(`Upload ${uploadId} cannot accept this operation in state ${state}`);
  }
}
