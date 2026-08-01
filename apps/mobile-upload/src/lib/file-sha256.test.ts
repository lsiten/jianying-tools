import { describe, expect, test } from "vitest";

import { hashFileSha256 } from "./file-sha256.js";

describe("file SHA-256", () => {
  test("hashes a Blob incrementally without requiring a whole-file ArrayBuffer", async () => {
    // Given: a file split across more than one bounded read.
    const file = new File(["ab", "c"], "sample.txt", { type: "text/plain" });
    const progress: number[] = [];

    // When: the H5 prepares integrity metadata for a transfer.
    const checksum = await hashFileSha256(file, {
      chunkBytes: 2,
      onProgress: (processedBytes) => progress.push(processedBytes),
    });

    // Then: its digest matches SHA-256 and progress is reported from bounded slices.
    expect(checksum).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(progress).toEqual([2, 3]);
  });
});
