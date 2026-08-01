import type {
  DeviceId,
  MaterialId,
  ProjectUploadKeyId,
  UploadId,
  UploadState,
} from "@jianying/contracts";

import type {
  ChunkAcknowledgement,
  CreateProjectTargetInput,
  PairedDevice,
  ProjectTarget,
  ProjectTargetSummary,
  ProjectUploadKey,
  RegisterPairedDeviceInput,
} from "./material-library-types.js";

export type StoredChunk = {
  readonly checksum_sha256: string;
  readonly chunk_index: string;
  readonly offset_bytes: string;
  readonly size_bytes: string;
};

export type StoredUpload = {
  readonly ack_epoch: string;
  readonly category_id: string;
  readonly expected_sha256: string;
  readonly expected_size_bytes: string;
  readonly file_name: string;
  readonly project_id: string;
  readonly received_bytes: string;
  readonly staging_path: string;
  readonly state: string;
  readonly upload_id: string;
};

export type StoredBlob = {
  readonly path: string;
};

export type StoredProjectUploadKey = {
  readonly category_id: string;
  readonly directory_name: string;
  readonly key_hash: string;
  readonly key_id: string;
  readonly project_id: string;
  readonly state: string;
};

export type StoredProjectUploadTransferBinding = {
  readonly device_id: string;
  readonly key_id: string;
};

export type UploadRecordInput = {
  readonly categoryId: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: bigint;
  readonly fileName: string;
  readonly projectId: string;
  readonly stagingPath: string;
  readonly uploadId: UploadId;
};

export type StoredChunkInput = {
  readonly checksumSha256: string;
  readonly chunkIndex: bigint;
  readonly offsetBytes: bigint;
  readonly sizeBytes: bigint;
  readonly uploadId: UploadId;
};

export interface MaterialLibraryStore {
  close(): void;
  countBlobs(): number;
  countMaterialReferences(): number;
  createProjectUploadKey(input: {
    readonly directoryName: string;
    readonly keyHash: string;
    readonly keyId: ProjectUploadKeyId;
    readonly target: ProjectTarget;
  }): ProjectUploadKey;
  createProjectUploadKeyBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
  }): void;
  createProjectTarget(input: CreateProjectTargetInput): ProjectTarget;
  createReadyReference(input: {
    readonly blobPath: string;
    readonly createBlob: boolean;
    readonly upload: StoredUpload;
  }): { readonly materialId: MaterialId };
  createUploadRecord(input: UploadRecordInput): void;
  createProjectUploadTransferBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
    readonly uploadId: UploadId;
  }): void;
  findBlob(sha256: string): StoredBlob | undefined;
  getChunks(uploadId: UploadId): readonly StoredChunk[];
  getPairedDevice(deviceId: DeviceId): PairedDevice | undefined;
  getProjectUploadKey(
    keyId: ProjectUploadKeyId,
  ): StoredProjectUploadKey | undefined;
  hasProjectUploadKeyBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
  }): boolean;
  getProjectUploadTransferBinding(
    uploadId: UploadId,
  ): StoredProjectUploadTransferBinding | undefined;
  getUpload(uploadId: UploadId): StoredUpload | undefined;
  listProjectTargets(): readonly ProjectTargetSummary[];
  listUploads(): readonly StoredUpload[];
  persistChunk(input: StoredChunkInput): ChunkAcknowledgement;
  reservedUploadBytes(): bigint;
  registerPairedDevice(input: RegisterPairedDeviceInput): void;
  revokeProjectUploadKey(keyId: ProjectUploadKeyId): void;
  setUploadState(uploadId: UploadId, state: UploadState): void;
}
