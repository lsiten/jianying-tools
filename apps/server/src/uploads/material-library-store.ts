import { randomUUID } from "node:crypto";
import {
  categoryIdSchema,
  type DeviceId,
  materialIdSchema,
  type ProjectUploadKeyId,
  projectIdSchema,
  type UploadId,
  type UploadState,
} from "@jianying/contracts";
import Database from "better-sqlite3";
import { createMaterialLibrarySchema } from "./material-library-schema.js";
import type {
  MaterialLibraryStore,
  StoredBlob,
  StoredChunk,
  StoredChunkInput,
  StoredProjectUploadTransferBinding,
  StoredUpload,
  UploadRecordInput,
} from "./material-library-store-types.js";
import type {
  ChunkAcknowledgement,
  CreateProjectTargetInput,
  PairedDevice,
  ProjectTarget,
  ProjectTargetSummary,
  ProjectUploadKey,
  RegisterPairedDeviceInput,
} from "./material-library-types.js";
import { SqlitePairedDeviceStore } from "./paired-device-store.js";
import { SqliteProjectUploadKeyStore } from "./project-upload-key-store.js";
import { UploadNotFoundError } from "./upload-errors.js";

export type {
  MaterialLibraryStore,
  StoredBlob,
  StoredChunk,
  StoredChunkInput,
  StoredProjectUploadTransferBinding,
  StoredUpload,
  UploadRecordInput,
} from "./material-library-store-types.js";

export function createMaterialLibraryStore(
  databasePath: string,
): MaterialLibraryStore {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  createMaterialLibrarySchema(database);
  return new SqliteMaterialLibraryStore(database);
}

class SqliteMaterialLibraryStore implements MaterialLibraryStore {
  private readonly pairedDevices: SqlitePairedDeviceStore;
  private readonly projectUploadKeys: SqliteProjectUploadKeyStore;

  constructor(private readonly database: Database.Database) {
    this.pairedDevices = new SqlitePairedDeviceStore(database);
    this.projectUploadKeys = new SqliteProjectUploadKeyStore(database);
  }

  createProjectTarget(input: CreateProjectTargetInput): ProjectTarget {
    const categoryId = categoryIdSchema.parse(randomUUID());
    const projectId = projectIdSchema.parse(randomUUID());
    this.database
      .prepare<[string, string, string, string]>(
        "INSERT INTO project_targets (project_id, category_id, project_name, category_name) VALUES (?, ?, ?, ?)",
      )
      .run(projectId, categoryId, input.projectName, input.categoryName);
    return { categoryId, projectId };
  }

  createProjectUploadKey(input: {
    readonly directoryName: string;
    readonly keyHash: string;
    readonly keyId: ProjectUploadKeyId;
    readonly target: ProjectTarget;
  }): ProjectUploadKey {
    return this.projectUploadKeys.create(input);
  }

  createProjectUploadKeyBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
  }): void {
    this.projectUploadKeys.createBinding(input);
  }

  createUploadRecord(input: UploadRecordInput): void {
    this.database
      .prepare<[string, string, string, string, string, string, string]>(
        "INSERT INTO uploads (upload_id, project_id, category_id, expected_size_bytes, expected_sha256, file_name, staging_path, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'transferring')",
      )
      .run(
        input.uploadId,
        input.projectId,
        input.categoryId,
        input.expectedSizeBytes.toString(),
        input.expectedSha256,
        input.fileName,
        input.stagingPath,
      );
  }

  createProjectUploadTransferBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
    readonly uploadId: UploadId;
  }): void {
    this.database
      .prepare<[string, string, string]>(
        "INSERT INTO project_upload_transfer_bindings (upload_id, key_id, device_id) VALUES (?, ?, ?)",
      )
      .run(input.uploadId, input.keyId, input.deviceId);
  }

  persistChunk(input: StoredChunkInput): ChunkAcknowledgement {
    return this.database.transaction(() => {
      const upload = this.getUpload(input.uploadId);
      if (upload === undefined) {
        throw new UploadNotFoundError(input.uploadId);
      }
      const acknowledgement: ChunkAcknowledgement = {
        ackEpoch: BigInt(upload.ack_epoch) + 1n,
        kind: "acknowledged",
        receivedBytes: BigInt(upload.received_bytes) + input.sizeBytes,
      };
      this.database
        .prepare<[string, string, string, string, string]>(
          "INSERT INTO upload_chunks (upload_id, chunk_index, offset_bytes, size_bytes, checksum_sha256) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.uploadId,
          input.chunkIndex.toString(),
          input.offsetBytes.toString(),
          input.sizeBytes.toString(),
          input.checksumSha256,
        );
      this.database
        .prepare<[string, string, string]>(
          "UPDATE uploads SET ack_epoch = ?, received_bytes = ? WHERE upload_id = ?",
        )
        .run(
          acknowledgement.ackEpoch.toString(),
          acknowledgement.receivedBytes.toString(),
          input.uploadId,
        );
      return acknowledgement;
    })();
  }

  createReadyReference(input: {
    readonly blobPath: string;
    readonly createBlob: boolean;
    readonly upload: StoredUpload;
  }): { readonly materialId: ReturnType<typeof materialIdSchema.parse> } {
    const materialId = materialIdSchema.parse(randomUUID());
    this.database.transaction(() => {
      if (input.createBlob) {
        this.database
          .prepare<[string, string, string]>(
            "INSERT INTO blobs (sha256, size_bytes, path) VALUES (?, ?, ?)",
          )
          .run(
            input.upload.expected_sha256,
            input.upload.expected_size_bytes,
            input.blobPath,
          );
      }
      this.database
        .prepare<[string, string, string, string, string]>(
          "INSERT INTO material_references (material_id, project_id, category_id, blob_sha256, upload_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          materialId,
          input.upload.project_id,
          input.upload.category_id,
          input.upload.expected_sha256,
          input.upload.upload_id,
        );
      this.database
        .prepare<[string]>(
          "UPDATE uploads SET state = 'ready' WHERE upload_id = ?",
        )
        .run(input.upload.upload_id);
    })();
    return { materialId };
  }

  getUpload(uploadId: UploadId): StoredUpload | undefined {
    return this.database
      .prepare<[string], StoredUpload>(
        "SELECT * FROM uploads WHERE upload_id = ?",
      )
      .get(uploadId);
  }

  listUploads(): readonly StoredUpload[] {
    return this.database
      .prepare<[], StoredUpload>("SELECT * FROM uploads")
      .all();
  }

  listProjectTargets(): readonly ProjectTargetSummary[] {
    return this.database
      .prepare<
        [],
        {
          readonly category_id: string;
          readonly category_name: string;
          readonly project_id: string;
          readonly project_name: string;
        }
      >(
        "SELECT project_id, category_id, project_name, category_name FROM project_targets ORDER BY project_name, category_name",
      )
      .all()
      .map((target) => ({
        categoryId: categoryIdSchema.parse(target.category_id),
        categoryName: target.category_name,
        projectId: projectIdSchema.parse(target.project_id),
        projectName: target.project_name,
      }));
  }

  getChunks(uploadId: UploadId): readonly StoredChunk[] {
    return this.database
      .prepare<[string], StoredChunk>(
        "SELECT chunk_index, offset_bytes, size_bytes, checksum_sha256 FROM upload_chunks WHERE upload_id = ?",
      )
      .all(uploadId);
  }

  getPairedDevice(deviceId: DeviceId): PairedDevice | undefined {
    return this.pairedDevices.get(deviceId);
  }

  getProjectUploadKey(
    keyId: ProjectUploadKeyId,
  ):
    | import("./material-library-store-types.js").StoredProjectUploadKey
    | undefined {
    return this.projectUploadKeys.get(keyId);
  }

  hasProjectUploadKeyBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
  }): boolean {
    return this.projectUploadKeys.hasBinding(input);
  }

  getProjectUploadTransferBinding(
    uploadId: UploadId,
  ): StoredProjectUploadTransferBinding | undefined {
    return this.database
      .prepare<[string], StoredProjectUploadTransferBinding>(
        "SELECT key_id, device_id FROM project_upload_transfer_bindings WHERE upload_id = ?",
      )
      .get(uploadId);
  }

  findBlob(sha256: string): StoredBlob | undefined {
    return this.database
      .prepare<[string], StoredBlob>("SELECT path FROM blobs WHERE sha256 = ?")
      .get(sha256);
  }

  reservedUploadBytes(): bigint {
    return this.database
      .prepare<[], { readonly expected_size_bytes: string }>(
        "SELECT expected_size_bytes FROM uploads WHERE state = 'transferring'",
      )
      .all()
      .reduce(
        (total, upload) => total + BigInt(upload.expected_size_bytes),
        0n,
      );
  }

  registerPairedDevice(input: RegisterPairedDeviceInput): void {
    this.pairedDevices.register(input);
  }

  revokeProjectUploadKey(keyId: ProjectUploadKeyId): void {
    this.projectUploadKeys.revoke(keyId);
  }

  setUploadState(uploadId: UploadId, state: UploadState): void {
    this.database
      .prepare<[string, string]>(
        "UPDATE uploads SET state = ? WHERE upload_id = ?",
      )
      .run(state, uploadId);
  }

  countBlobs(): number {
    return this.count("blobs");
  }

  countMaterialReferences(): number {
    return this.count("material_references");
  }

  close(): void {
    this.database.close();
  }

  private count(table: "blobs" | "material_references"): number {
    return (
      this.database
        .prepare<[], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM ${table}`,
        )
        .get()?.count ?? 0
    );
  }
}
