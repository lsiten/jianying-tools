import { mkdtemp, rm } from "node:fs/promises";
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

describe("material library schema migration", () => {
  test("migrates legacy integer chunk indexes without losing acknowledged chunks", async () => {
    // Given: a pre-64-bit installation that persisted a confirmed chunk index as INTEGER.
    const directory = await mkdtemp(
      join(tmpdir(), "jianying-schema-migration-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    const legacyDatabase = new Database(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE upload_chunks (upload_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, offset_bytes TEXT NOT NULL, size_bytes TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, PRIMARY KEY (upload_id, chunk_index));
    `);
    legacyDatabase
      .prepare(
        "INSERT INTO upload_chunks (upload_id, chunk_index, offset_bytes, size_bytes, checksum_sha256) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "90e46cd5-45d2-4fa7-a4c5-1f5d765d3a00",
        42,
        "0",
        "5",
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    legacyDatabase.close();

    // When: the upgraded local server opens the same database.
    const library = await createMaterialLibrary({
      availableBytes: async () => 1_000_000_000_000_000n,
      databasePath,
      materialRootPath: join(directory, "materials"),
    });

    // Then: the old acknowledgement is retained and future 64-bit indexes use TEXT semantics.
    const verificationDatabase = new Database(databasePath);
    const column = verificationDatabase
      .prepare<[], { readonly type: string }>(
        "SELECT type FROM pragma_table_info('upload_chunks') WHERE name = 'chunk_index'",
      )
      .get();
    const chunk = verificationDatabase
      .prepare<[], { readonly chunk_index: string }>(
        "SELECT chunk_index FROM upload_chunks",
      )
      .get();
    verificationDatabase.close();
    library.close();
    expect(column).toEqual({ type: "TEXT" });
    expect(chunk).toEqual({ chunk_index: "42" });
  });
});
