import type Database from "better-sqlite3";

/** Creates the SQLite tables that define the local material-library persistence model. */
export function createMaterialLibrarySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS project_targets (project_id TEXT NOT NULL, category_id TEXT PRIMARY KEY, project_name TEXT NOT NULL, category_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS uploads (upload_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category_id TEXT NOT NULL, expected_size_bytes TEXT NOT NULL, expected_sha256 TEXT NOT NULL, file_name TEXT NOT NULL, staging_path TEXT NOT NULL, state TEXT NOT NULL, ack_epoch TEXT NOT NULL DEFAULT '0', received_bytes TEXT NOT NULL DEFAULT '0');
    CREATE TABLE IF NOT EXISTS upload_chunks (upload_id TEXT NOT NULL, chunk_index TEXT NOT NULL, offset_bytes TEXT NOT NULL, size_bytes TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, PRIMARY KEY (upload_id, chunk_index));
    CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, size_bytes TEXT NOT NULL, path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS material_references (material_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category_id TEXT NOT NULL, blob_sha256 TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS paired_devices (device_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, public_key_spki_base64url TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS project_upload_keys (key_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category_id TEXT NOT NULL, directory_name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('active', 'revoked')));
    CREATE TABLE IF NOT EXISTS project_upload_key_bindings (key_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (key_id, device_id));
    CREATE TABLE IF NOT EXISTS project_upload_transfer_bindings (upload_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, device_id TEXT NOT NULL);
  `);
  migrateChunkIndexToText(database);
}

function migrateChunkIndexToText(database: Database.Database): void {
  const columns = database
    .prepare<[], { readonly name: string; readonly type: string }>(
      "PRAGMA table_info(upload_chunks)",
    )
    .all();
  const chunkIndexColumn = columns.find(
    (column) => column.name === "chunk_index",
  );
  if (chunkIndexColumn?.type.toUpperCase() === "TEXT") {
    return;
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE upload_chunks_v2 (upload_id TEXT NOT NULL, chunk_index TEXT NOT NULL, offset_bytes TEXT NOT NULL, size_bytes TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, PRIMARY KEY (upload_id, chunk_index));
      INSERT INTO upload_chunks_v2 (upload_id, chunk_index, offset_bytes, size_bytes, checksum_sha256) SELECT upload_id, CAST(chunk_index AS TEXT), offset_bytes, size_bytes, checksum_sha256 FROM upload_chunks;
      DROP TABLE upload_chunks;
      ALTER TABLE upload_chunks_v2 RENAME TO upload_chunks;
    `);
  })();
}
