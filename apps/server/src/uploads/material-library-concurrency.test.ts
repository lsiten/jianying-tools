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

describe("material library concurrency", () => {
  test("rejects a conflicting simultaneous replay without corrupting the staging file", async () => {
    // Given: one single-byte upload and two concurrently delivered chunk-zero packets.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "pet-vlog",
    });
    const upload = await library.createUpload({
      expectedSha256:
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      expectedSizeBytes: 1n,
      fileName: "pet.mov",
      target,
    });

    // When: the valid packet and a conflicting replay race on the same chunk index.
    const outcomes = await Promise.allSettled([
      library.appendChunk({
        bytes: new TextEncoder().encode("a"),
        checksumSha256:
          "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
        chunkIndex: 0n,
        offsetBytes: 0n,
        uploadId: upload.uploadId,
      }),
      library.appendChunk({
        bytes: new TextEncoder().encode("b"),
        checksumSha256:
          "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
        chunkIndex: 0n,
        offsetBytes: 0n,
        uploadId: upload.uploadId,
      }),
    ]);

    // Then: arrival order remains deterministic and the completed file is the accepted packet.
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]?.status).toBe("rejected");
    if (outcomes[1]?.status === "rejected") {
      expect(outcomes[1].reason).toMatchObject({
        name: "UploadIntegrityError",
        reason: "CHUNK_INDEX_REPLAY_MISMATCH",
      });
    }
    expect(await library.completeUpload(upload.uploadId)).toMatchObject({
      kind: "ready",
    });
  });
});

async function createTestLibrary(): Promise<MaterialLibrary> {
  const directory = await mkdtemp(
    join(tmpdir(), "jianying-material-concurrency-"),
  );
  temporaryDirectories.push(directory);
  return createMaterialLibrary({
    availableBytes: async () => 1_000_000_000_000_000n,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
  });
}
