import type {
  CategoryId,
  DeviceId,
  MaterialId,
  ProjectId,
  ProjectUploadKeyId,
  UploadId,
  UploadState,
} from "@jianying/contracts";

export type PairedDevice = {
  readonly deviceId: DeviceId;
  readonly displayName: string;
  readonly publicKeySpkiBase64Url: string;
};

export type RegisterPairedDeviceInput = PairedDevice;

export type ProjectTarget = {
  readonly categoryId: CategoryId;
  readonly projectId: ProjectId;
};

export type CreateProjectTargetInput = {
  readonly categoryName: string;
  readonly projectName: string;
};

export type ProjectTargetSummary = ProjectTarget & {
  readonly categoryName: string;
  readonly projectName: string;
};

export type ProjectUploadKeyState = "active" | "revoked";

export type ProjectUploadKey = {
  readonly directoryName: string;
  readonly keyId: ProjectUploadKeyId;
  readonly state: ProjectUploadKeyState;
  readonly target: ProjectTarget;
};

export type CreatedProjectUploadKey = {
  readonly rawKey: string;
  readonly uploadKey: ProjectUploadKey;
};

export type RedeemProjectUploadKeyInput = {
  readonly deviceId: DeviceId;
  readonly displayName: string;
  readonly publicKeySpkiBase64Url: string;
  readonly rawKey: string;
};

export type ProjectUploadKeyBinding = {
  readonly deviceId: DeviceId;
  readonly directoryName: string;
  readonly keyId: ProjectUploadKeyId;
  readonly target: ProjectTarget;
};

export type CreateUploadInput = {
  readonly expectedSha256: string;
  readonly expectedSizeBytes: bigint;
  readonly fileName: string;
  readonly target: ProjectTarget;
};

export type CreatedUpload = {
  readonly uploadId: UploadId;
};

export type CreateProjectUploadInput = {
  readonly deviceId: DeviceId;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: bigint;
  readonly fileName: string;
  readonly keyId: ProjectUploadKeyId;
};

export type ResumeProjectUploadInput = CreateProjectUploadInput & {
  readonly uploadId: UploadId;
};

export type AppendChunkInput = {
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly chunkIndex: bigint;
  readonly offsetBytes: bigint;
  readonly uploadId: UploadId;
};

export type ChunkAcknowledgement = {
  readonly ackEpoch: bigint;
  readonly kind: "acknowledged";
  readonly receivedBytes: bigint;
};

export type UploadSnapshot = {
  readonly ackEpoch: bigint;
  readonly receivedBytes: bigint;
  readonly state: UploadState;
  readonly uploadId: UploadId;
};

export type StorageStatus = {
  readonly availableBytes: bigint;
  readonly reservedBytes: bigint;
};

export const UPLOAD_COMPLETION_ERROR_REASONS = {
  BLOB_MISSING: "BLOB_MISSING",
  SHA256_MISMATCH: "SHA256_MISMATCH",
  STAGING_FILE_MISSING: "STAGING_FILE_MISSING",
  UPLOAD_INCOMPLETE: "UPLOAD_INCOMPLETE",
} as const;

export type UploadCompletionErrorReason =
  (typeof UPLOAD_COMPLETION_ERROR_REASONS)[keyof typeof UPLOAD_COMPLETION_ERROR_REASONS];

export type CompletedUpload =
  | {
      readonly kind: "ready";
      readonly materialId: MaterialId;
      readonly path: string;
    }
  | {
      readonly kind: "recoverable_error";
      readonly reason: UploadCompletionErrorReason;
    };
