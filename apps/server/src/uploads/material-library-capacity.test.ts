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

describe("material library capacity", () => {
  test("persists a multi-terabyte reservation when the real volume covers it", async () => {
    // Given: a real SQLite-backed library and capacity for a multi-terabyte source file.
    const expectedSizeBytes = 9_999_999_999_999n;
    const library = await createTestLibrary(expectedSizeBytes);
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "long-form-vlog",
    });

    // When: the phone starts a transfer that does not fit a historic product threshold.
    const created = await library.createUpload({
      expectedSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expectedSizeBytes,
      fileName: "multi-terabyte-vlog.mov",
      target,
    });

    // Then: the durable reservation matches the actual file size without a business cap.
    expect(library.getUpload(created.uploadId)).toMatchObject({
      receivedBytes: 0n,
      state: "transferring",
    });
    await expect(library.storageStatus()).resolves.toEqual({
      availableBytes: expectedSizeBytes,
      reservedBytes: expectedSizeBytes,
    });
    library.close();
  });

  test("admits a 1024-item concurrent batch when the real volume covers it", async () => {
    // Given: a batch whose cardinality exceeds common product quotas.
    const batchItemCount = 1_024;
    const library = await createTestLibrary(BigInt(batchItemCount));
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "unlimited-batch-vlog",
    });

    // When: every one-byte item asks for a durable reservation at once.
    const created = await Promise.all(
      Array.from({ length: batchItemCount }, async (_value, index) =>
        library.createUpload({
          expectedSha256:
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
          expectedSizeBytes: 1n,
          fileName: `batch-${index}.mov`,
          target,
        }),
      ),
    );

    // Then: all requests are admitted by actual reserved bytes, not a batch count cap.
    expect(created).toHaveLength(batchItemCount);
    await expect(library.storageStatus()).resolves.toEqual({
      availableBytes: BigInt(batchItemCount),
      reservedBytes: BigInt(batchItemCount),
    });
    library.close();
  }, 20_000);
});

async function createTestLibrary(
  availableBytes: bigint,
): Promise<MaterialLibrary> {
  const directory = await mkdtemp(
    join(tmpdir(), "jianying-material-library-capacity-"),
  );
  temporaryDirectories.push(directory);

  return createMaterialLibrary({
    availableBytes: async () => availableBytes,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
  });
}
