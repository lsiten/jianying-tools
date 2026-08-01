import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  createMaterialLibrary,
  type MaterialLibrary,
} from "./material-library.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

describe("material completion", () => {
  test("persists a recoverable state when final file verification fails", async () => {
    // Given: a fully transferred file whose declared full-file hash is incorrect.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "pet-vlog",
    });
    const upload = await library.createUpload({
      expectedSha256:
        "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
      expectedSizeBytes: 1n,
      fileName: "pet.mov",
      target,
    });
    await library.appendChunk({
      bytes: new TextEncoder().encode("a"),
      checksumSha256:
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      chunkIndex: 0n,
      offsetBytes: 0n,
      uploadId: upload.uploadId,
    });

    // When: the server verifies the completed staging file.
    const completion = await library.completeUpload(upload.uploadId);

    // Then: later restart recovery sees an explicit error state, never a fake transfer.
    expect(completion).toEqual({
      kind: "recoverable_error",
      reason: "SHA256_MISMATCH",
    });
    expect(library.getUpload(upload.uploadId).state).toBe("recoverable_error");
  });
});

async function createTestLibrary(): Promise<MaterialLibrary> {
  const directory = await mkdtemp(
    join(tmpdir(), "jianying-material-completion-"),
  );
  temporaryDirectories.push(directory);
  return createMaterialLibrary({
    availableBytes: async () => 1_000_000_000_000_000n,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
  });
}
