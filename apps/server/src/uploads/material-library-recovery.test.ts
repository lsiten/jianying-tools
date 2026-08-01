import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { createMaterialLibrary } from "./material-library.js";

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

describe("material library recovery", () => {
  test("finishes a verified upload after a restart before final commit", async () => {
    // Given: a complete staging file and durable state from immediately after hash verification.
    const directory = await mkdtemp(
      join(tmpdir(), "jianying-material-recovery-"),
    );
    temporaryDirectories.push(directory);
    const config = {
      availableBytes: async () => 1_000_000_000_000_000n,
      databasePath: join(directory, "state.sqlite"),
      materialRootPath: join(directory, "materials"),
    };
    const firstProcess = await createMaterialLibrary(config);
    const target = firstProcess.createProjectTarget({
      categoryName: "raw-video",
      projectName: "pet-vlog",
    });
    const upload = await firstProcess.createUpload({
      expectedSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expectedSizeBytes: 5n,
      fileName: "pet.mov",
      target,
    });
    await firstProcess.appendChunk({
      bytes: new TextEncoder().encode("hello"),
      checksumSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      chunkIndex: 0n,
      offsetBytes: 0n,
      uploadId: upload.uploadId,
    });
    firstProcess.close();
    const database = new Database(config.databasePath);
    database
      .prepare("UPDATE uploads SET state = 'hash_verified' WHERE upload_id = ?")
      .run(upload.uploadId);
    database.close();

    // When: a new server process opens the same database and material volume.
    const recoveredProcess = await createMaterialLibrary(config);

    // Then: it atomically publishes the blob and final logical reference without user action.
    expect(recoveredProcess.getUpload(upload.uploadId).state).toBe("ready");
    expect(recoveredProcess.countBlobs()).toBe(1);
    expect(recoveredProcess.countMaterialReferences()).toBe(1);
    const verificationDatabase = new Database(config.databasePath);
    const blob = verificationDatabase
      .prepare<[], { readonly path: string }>("SELECT path FROM blobs")
      .get();
    verificationDatabase.close();
    expect(blob).toBeDefined();
    if (blob !== undefined) {
      expect(await readFile(blob.path, "utf8")).toBe("hello");
    }
  });
});
