import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceIdSchema } from "@jianying/contracts";
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

describe("material library", () => {
  test("persists out-of-order chunks before acknowledging their progress", async () => {
    // Given: a project target and a five-byte upload staged on an APFS-like volume.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "weekend-vlog",
    });
    const upload = await library.createUpload({
      expectedSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expectedSizeBytes: 5n,
      fileName: "hello.mov",
      target,
    });

    // When: chunks arrive in reverse order.
    const secondAcknowledgement = await library.appendChunk({
      bytes: new TextEncoder().encode("llo"),
      checksumSha256:
        "13d896353557f29e6c8aac4bde65c743f4206df820ff8328ae567f924189d339",
      chunkIndex: 1n,
      offsetBytes: 2n,
      uploadId: upload.uploadId,
    });
    await library.appendChunk({
      bytes: new TextEncoder().encode("he"),
      checksumSha256:
        "372f7e2fd2d01ce2a1d71dc072acbba4c6fd25a1087cd7f153f4ec0ce37e1ede",
      chunkIndex: 0n,
      offsetBytes: 0n,
      uploadId: upload.uploadId,
    });
    const readyMaterial = await library.completeUpload(upload.uploadId);

    // Then: the ack is durable and the final file is only published after full verification.
    expect(secondAcknowledgement).toEqual({
      ackEpoch: 1n,
      kind: "acknowledged",
      receivedBytes: 3n,
    });
    expect(readyMaterial.kind).toBe("ready");
    if (readyMaterial.kind === "ready") {
      expect(await readFile(readyMaterial.path, "utf8")).toBe("hello");
    }
    expect(library.getUpload(upload.uploadId)).toMatchObject({
      ackEpoch: 2n,
      receivedBytes: 5n,
      state: "ready",
    });
  });

  test("creates another logical reference instead of a second physical exact duplicate", async () => {
    // Given: two target categories and the same original bytes.
    const library = await createTestLibrary();
    const firstTarget = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "pet-vlog",
    });
    const secondTarget = library.createProjectTarget({
      categoryName: "favorites",
      projectName: "life-vlog",
    });
    const expectedSha256 =
      "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7";

    // When: both uploads complete.
    const first = await completeOneChunkUpload({
      bytes: new TextEncoder().encode("data"),
      expectedSha256,
      library,
      target: firstTarget,
    });
    const second = await completeOneChunkUpload({
      bytes: new TextEncoder().encode("data"),
      expectedSha256,
      library,
      target: secondTarget,
    });

    // Then: both logical materials point at one content-addressed blob.
    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind === "ready" && second.kind === "ready") {
      expect(first.path).toBe(second.path);
    }
    expect(library.countBlobs()).toBe(1);
    expect(library.countMaterialReferences()).toBe(2);
  });

  test("acknowledges an identical chunk replay without writing or counting it twice", async () => {
    // Given: a staged upload whose one chunk has already been durably acknowledged.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "weekend-vlog",
    });
    const upload = await library.createUpload({
      expectedSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expectedSizeBytes: 5n,
      fileName: "hello.mov",
      target,
    });
    const chunk = {
      bytes: new TextEncoder().encode("hello"),
      checksumSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      chunkIndex: 0n,
      offsetBytes: 0n,
      uploadId: upload.uploadId,
    };
    const firstAcknowledgement = await library.appendChunk(chunk);

    // When: a reconnect replays the exact same logical chunk.
    const replayAcknowledgement = await library.appendChunk(chunk);

    // Then: recovery is idempotent rather than consuming capacity or advancing the epoch.
    expect(replayAcknowledgement).toEqual(firstAcknowledgement);
    expect(library.getUpload(upload.uploadId)).toMatchObject({
      ackEpoch: 1n,
      receivedBytes: 5n,
    });
  });

  test("rejects a chunk before acknowledgement when its declared checksum is wrong", async () => {
    // Given: a valid target and an empty one-byte upload.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "weekend-vlog",
    });
    const upload = await library.createUpload({
      expectedSha256:
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      expectedSizeBytes: 1n,
      fileName: "a.mov",
      target,
    });

    // When: the sender provides bytes with a mismatched chunk checksum.
    const append = library.appendChunk({
      bytes: new TextEncoder().encode("a"),
      checksumSha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
      chunkIndex: 0n,
      offsetBytes: 0n,
      uploadId: upload.uploadId,
    });

    // Then: no bytes are acknowledged, so a retry can safely resume.
    await expect(append).rejects.toMatchObject({
      name: "UploadIntegrityError",
      reason: "CHUNK_CHECKSUM_MISMATCH",
    });
    expect(library.getUpload(upload.uploadId)).toMatchObject({
      ackEpoch: 0n,
      receivedBytes: 0n,
    });
  });

  test("checks current storage capacity before staging an upload", async () => {
    // Given: the local volume currently has no user-available bytes.
    const library = await createTestLibrary(async () => 0n);
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "weekend-vlog",
    });

    // When: a client asks to stage even a one-byte material.
    const createUpload = library.createUpload({
      expectedSha256:
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      expectedSizeBytes: 1n,
      fileName: "a.mov",
      target,
    });

    // Then: the library rejects before creating a staging file or database record.
    await expect(createUpload).rejects.toMatchObject({
      name: "StorageReservationError",
      uploadBytes: 1n,
    });
  });

  test("releases only a cancelled transfer reservation for the next unlimited batch item", async () => {
    // Given: the volume currently has capacity for exactly one five-byte material.
    const library = await createTestLibrary(async () => 5n);
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "weekend-vlog",
    });
    const first = await library.createUpload({
      expectedSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expectedSizeBytes: 5n,
      fileName: "first.mov",
      target,
    });

    // When: the phone cancels this item before the next item in its batch is admitted.
    await library.cancelUpload(first.uploadId);
    const second = await library.createUpload({
      expectedSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expectedSizeBytes: 5n,
      fileName: "second.mov",
      target,
    });

    // Then: cancellation is terminal and releases the actual storage reservation, not a product quota.
    expect(library.getUpload(first.uploadId).state).toBe("cancelled");
    expect(library.getUpload(second.uploadId).state).toBe("transferring");
  });

  test("admits every item in a large batch when the material volume can reserve them", async () => {
    // Given: a batch with no product cardinality cap and exactly enough real volume capacity.
    const batchItemCount = 128;
    const library = await createTestLibrary(async () => BigInt(batchItemCount));
    const target = library.createProjectTarget({
      categoryName: "raw-video",
      projectName: "weekend-vlog",
    });

    // When: all batch items request one-byte reservations concurrently.
    const uploads = await Promise.all(
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

    // Then: admission is determined only by summed reservations, not a batch item threshold.
    expect(uploads).toHaveLength(batchItemCount);
    expect(
      uploads.every(
        (upload) => library.getUpload(upload.uploadId).state === "transferring",
      ),
    ).toBe(true);
  });

  test("persists a paired device signing key across a local service restart", async () => {
    // Given: a device public key produced by the phone secure key store.
    const directory = await mkdtemp(join(tmpdir(), "jianying-paired-device-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    const deviceId = deviceIdSchema.parse(
      "2ee77da2-3d07-4d91-b290-f2c560ae046d",
    );
    const keyPair = generateKeyPairSync("ed25519");
    const publicKeySpkiBase64Url = keyPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    const first = await createMaterialLibrary({
      availableBytes: async () => 1_000_000_000_000_000n,
      databasePath,
      materialRootPath: join(directory, "materials"),
    });
    first.registerPairedDevice({
      deviceId,
      displayName: "iPhone",
      publicKeySpkiBase64Url,
    });
    first.close();

    // When: the local server starts again using the durable user state.
    const reopened = await createMaterialLibrary({
      availableBytes: async () => 1_000_000_000_000_000n,
      databasePath,
      materialRootPath: join(directory, "materials"),
    });

    // Then: the transfer authorizer can retrieve the exact paired identity without a cloud lookup.
    expect(reopened.getPairedDevice(deviceId)).toEqual({
      deviceId,
      displayName: "iPhone",
      publicKeySpkiBase64Url,
    });
    reopened.close();
  });
});

async function createTestLibrary(
  availableBytes: () => Promise<bigint> = async () => 1_000_000_000_000_000n,
): Promise<MaterialLibrary> {
  const directory = await mkdtemp(join(tmpdir(), "jianying-material-library-"));
  temporaryDirectories.push(directory);

  return createMaterialLibrary({
    availableBytes,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
  });
}

async function completeOneChunkUpload(input: {
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  readonly library: MaterialLibrary;
  readonly target: ReturnType<MaterialLibrary["createProjectTarget"]>;
}): Promise<Awaited<ReturnType<MaterialLibrary["completeUpload"]>>> {
  const upload = await input.library.createUpload({
    expectedSha256: input.expectedSha256,
    expectedSizeBytes: BigInt(input.bytes.byteLength),
    fileName: "duplicate.mp4",
    target: input.target,
  });
  await input.library.appendChunk({
    bytes: input.bytes,
    checksumSha256: input.expectedSha256,
    chunkIndex: 0n,
    offsetBytes: 0n,
    uploadId: upload.uploadId,
  });

  return input.library.completeUpload(upload.uploadId);
}
