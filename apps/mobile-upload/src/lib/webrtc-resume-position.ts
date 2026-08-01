import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";

export function createResumeTransferPosition(input: {
  readonly fileSize: number;
  readonly maxChunkBytes: number;
  readonly receivedBytes: number;
}): { readonly chunkIndex: bigint; readonly offsetBytes: number } {
  if (
    !Number.isSafeInteger(input.receivedBytes) ||
    input.receivedBytes < 0 ||
    input.receivedBytes > input.fileSize ||
    (input.receivedBytes !== input.fileSize &&
      input.receivedBytes % input.maxChunkBytes !== 0)
  ) {
    throw new WebRtcFileTransferError("CONTROL_REJECTED");
  }
  return {
    chunkIndex: BigInt(Math.floor(input.receivedBytes / input.maxChunkBytes)),
    offsetBytes: input.receivedBytes,
  };
}
