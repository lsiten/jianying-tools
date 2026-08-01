import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("project upload keys", () => {
  test("binds each created Key to one project directory and revokes it independently", async () => {
    // Given: a Mac project target and a phone-generated non-exportable Ed25519 public key.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "morning-walks",
      projectName: "pet-vlog",
    });
    const deviceId = deviceIdSchema.parse(
      "2ee77da2-3d07-4d91-b290-f2c560ae046d",
    );
    const keyPair = generateKeyPairSync("ed25519");
    const publicKeySpkiBase64Url = keyPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    const created = library.createProjectUploadKey({
      directoryName: "晨间遛狗",
      target,
    });

    // When: the mobile H5 redeems the Key and the desktop later revokes only that Key.
    const paired = library.redeemProjectUploadKey({
      deviceId,
      displayName: "iPhone Safari",
      publicKeySpkiBase64Url,
      rawKey: created.rawKey,
    });
    library.revokeProjectUploadKey(created.uploadKey.keyId);

    // Then: the H5 receives only its bound directory, and revocation cannot affect other keys.
    expect(created.rawKey).toMatch(/^jyup1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(created.uploadKey).toMatchObject({
      directoryName: "晨间遛狗",
      state: "active",
      target,
    });
    expect(paired).toMatchObject({
      deviceId,
      directoryName: "晨间遛狗",
      keyId: created.uploadKey.keyId,
      target,
    });
    expect(() =>
      library.redeemProjectUploadKey({
        deviceId,
        displayName: "iPhone Safari",
        publicKeySpkiBase64Url,
        rawKey: created.rawKey,
      }),
    ).toThrow(
      expect.objectContaining({ reason: "PROJECT_UPLOAD_KEY_REVOKED" }),
    );
    library.close();
  });

  test("rejects an invalid mobile public key as an unauthorized Key redemption", async () => {
    // Given: a valid one-time Key and a mobile request whose claimed public key is not Ed25519 SPKI.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "runtime-probe",
      projectName: "control-rendezvous",
    });
    const created = library.createProjectUploadKey({
      directoryName: "runtime-probe-materials",
      target,
    });

    // When: that request reaches the local Key authority.
    const redeem = () =>
      library.redeemProjectUploadKey({
        deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
        displayName: "Runtime control probe",
        publicKeySpkiBase64Url: "dGVzdF9wdWJsaWNfa2V5",
        rawKey: created.rawKey,
      });

    // Then: it is an expected authorization refusal, never a process-level input error.
    expect(redeem).toThrow(
      expect.objectContaining({ reason: "PROJECT_UPLOAD_KEY_UNAUTHORIZED" }),
    );
    library.close();
  });

  test("resolves an upload target only for the device paired to that active Key", async () => {
    // Given: a Key has been redeemed by one H5 device for a project directory.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "city-walks",
      projectName: "life-vlog",
    });
    const deviceId = deviceIdSchema.parse(
      "2ee77da2-3d07-4d91-b290-f2c560ae046d",
    );
    const keyPair = generateKeyPairSync("ed25519");
    const created = library.createProjectUploadKey({
      directoryName: "周末散步",
      target,
    });
    library.redeemProjectUploadKey({
      deviceId,
      displayName: "iPhone Safari",
      publicKeySpkiBase64Url: keyPair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      rawKey: created.rawKey,
    });

    // When: the paired device asks the Mac to prepare a new file transfer.
    const binding = library.resolveProjectUploadKeyBinding({
      deviceId,
      keyId: created.uploadKey.keyId,
    });

    // Then: the server supplies the stored directory target rather than accepting one from the phone.
    expect(binding).toEqual({
      directoryName: "周末散步",
      keyId: created.uploadKey.keyId,
      target,
    });
    library.close();
  });

  test("resumes only the upload bound to the same paired device, Key, and file identity", async () => {
    // Given: a paired Key has created an interrupted remote upload with immutable file metadata.
    const library = await createTestLibrary();
    const target = library.createProjectTarget({
      categoryName: "city-walks",
      projectName: "life-vlog",
    });
    const deviceId = deviceIdSchema.parse(
      "2ee77da2-3d07-4d91-b290-f2c560ae046d",
    );
    const createdKey = library.createProjectUploadKey({
      directoryName: "周末散步",
      target,
    });
    const keyPair = generateKeyPairSync("ed25519");
    library.redeemProjectUploadKey({
      deviceId,
      displayName: "iPhone Safari",
      publicKeySpkiBase64Url: keyPair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      rawKey: createdKey.rawKey,
    });
    const upload = await library.createProjectUpload({
      deviceId,
      expectedSha256:
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      expectedSizeBytes: 1n,
      fileName: "walk.mp4",
      keyId: createdKey.uploadKey.keyId,
    });

    // When: the original browser asks to resume and another file identity is attempted.
    const resumed = library.resumeProjectUpload({
      deviceId,
      expectedSha256:
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      expectedSizeBytes: 1n,
      fileName: "walk.mp4",
      keyId: createdKey.uploadKey.keyId,
      uploadId: upload.uploadId,
    });

    // Then: only the exact persisted binding can receive a new short-lived session.
    expect(resumed).toMatchObject({
      receivedBytes: 0n,
      state: "transferring",
      uploadId: upload.uploadId,
    });
    expect(() =>
      library.resumeProjectUpload({
        deviceId,
        expectedSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedSizeBytes: 1n,
        fileName: "walk.mp4",
        keyId: createdKey.uploadKey.keyId,
        uploadId: upload.uploadId,
      }),
    ).toThrow(
      expect.objectContaining({ reason: "PROJECT_UPLOAD_KEY_UNAUTHORIZED" }),
    );
    library.close();
  });
});

async function createTestLibrary(): Promise<MaterialLibrary> {
  const directory = await mkdtemp(
    join(tmpdir(), "jianying-project-upload-key-"),
  );
  temporaryDirectories.push(directory);
  return createMaterialLibrary({
    availableBytes: async () => 1_000_000_000_000_000n,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
    projectUploadNodeId: "test_upload_node_id_01",
    projectUploadKeyPepper: "test-project-upload-key-pepper",
  });
}
