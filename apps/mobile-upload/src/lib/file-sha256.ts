import { createSHA256 } from "hash-wasm";

export class FileSha256Error extends Error {
  readonly name = "FileSha256Error";

  constructor(readonly reason: "INVALID_CHUNK_SIZE") {
    super(`File SHA-256 failed: ${reason}`);
  }
}

/** Streams browser file slices through a WASM hasher, retaining only one bounded chunk in memory. */
export async function hashFileSha256(
  file: Blob,
  input: {
    readonly chunkBytes: number;
    readonly onProgress?: (processedBytes: number) => void;
  },
): Promise<string> {
  if (!Number.isSafeInteger(input.chunkBytes) || input.chunkBytes < 1) {
    throw new FileSha256Error("INVALID_CHUNK_SIZE");
  }
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += input.chunkBytes) {
    const chunk = new Uint8Array(
      await file.slice(offset, offset + input.chunkBytes).arrayBuffer(),
    );
    hasher.update(chunk);
    input.onProgress?.(Math.min(offset + chunk.byteLength, file.size));
  }
  return hasher.digest();
}
