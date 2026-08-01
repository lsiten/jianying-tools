import type { UploadId } from "@jianying/contracts";

import { hashBytes } from "./material-layout.js";
import type {
  StoredChunk,
  StoredUpload,
} from "./material-library-store-types.js";
import type { AppendChunkInput } from "./material-library-types.js";
import { UploadIntegrityError, UploadStateError } from "./upload-errors.js";

export function assertChunkFits(
  input: AppendChunkInput,
  upload: StoredUpload,
  chunks: readonly StoredChunk[],
): void {
  const end = input.offsetBytes + BigInt(input.bytes.byteLength);
  const overlaps = chunks.some(
    (chunk) =>
      input.offsetBytes <
        BigInt(chunk.offset_bytes) + BigInt(chunk.size_bytes) &&
      BigInt(chunk.offset_bytes) < end,
  );
  if (
    input.offsetBytes < 0n ||
    end > BigInt(upload.expected_size_bytes) ||
    overlaps
  ) {
    throw new UploadIntegrityError(input.uploadId, "CHUNK_RANGE_INVALID");
  }
}

export function assertChunkMatches(input: AppendChunkInput): void {
  if (hashBytes(input.bytes) !== input.checksumSha256) {
    throw new UploadIntegrityError(input.uploadId, "CHUNK_CHECKSUM_MISMATCH");
  }
}

export function assertDuplicateMatches(
  input: AppendChunkInput,
  duplicate: StoredChunk,
): void {
  if (
    duplicate.offset_bytes !== input.offsetBytes.toString() ||
    duplicate.size_bytes !== String(input.bytes.byteLength) ||
    duplicate.checksum_sha256 !== input.checksumSha256
  ) {
    throw new UploadIntegrityError(
      input.uploadId,
      "CHUNK_INDEX_REPLAY_MISMATCH",
    );
  }
}

export function assertTransferring(uploadId: UploadId, state: string): void {
  if (state !== "transferring") {
    throw new UploadStateError(uploadId, state);
  }
}
