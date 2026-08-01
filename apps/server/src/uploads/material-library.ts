import type {
  DeviceId,
  ProjectUploadKeyId,
  UploadId,
} from "@jianying/contracts";

import { createMaterialLayout } from "./material-layout.js";
import { reconcileMaterialLibrary } from "./material-library-recovery.js";
import { createMaterialLibraryStore } from "./material-library-store.js";
import type {
  AppendChunkInput,
  ChunkAcknowledgement,
  CompletedUpload,
  CreatedProjectUploadKey,
  CreatedUpload,
  CreateProjectTargetInput,
  CreateProjectUploadInput,
  CreateUploadInput,
  PairedDevice,
  ProjectTarget,
  ProjectTargetSummary,
  ProjectUploadKeyBinding,
  RedeemProjectUploadKeyInput,
  RegisterPairedDeviceInput,
  ResumeProjectUploadInput,
  StorageStatus,
  UploadSnapshot,
} from "./material-library-types.js";
import { SqliteMaterialLibrary } from "./sqlite-material-library.js";

export type MaterialLibraryConfig = {
  readonly availableBytes: () => Promise<bigint>;
  readonly databasePath: string;
  readonly materialRootPath: string;
  readonly projectUploadNodeId?: string;
  readonly projectUploadKeyPepper?: string;
};

export interface MaterialLibrary {
  appendChunk(input: AppendChunkInput): Promise<ChunkAcknowledgement>;
  cancelUpload(uploadId: UploadId): Promise<void>;
  close(): void;
  completeUpload(uploadId: UploadId): Promise<CompletedUpload>;
  countBlobs(): number;
  countMaterialReferences(): number;
  createProjectTarget(input: CreateProjectTargetInput): ProjectTarget;
  createProjectUploadKey(input: {
    readonly directoryName: string;
    readonly target: ProjectTarget;
  }): CreatedProjectUploadKey;
  createProjectUpload(input: CreateProjectUploadInput): Promise<CreatedUpload>;
  createUpload(input: CreateUploadInput): Promise<CreatedUpload>;
  getPairedDevice(deviceId: DeviceId): PairedDevice | undefined;
  getUpload(uploadId: UploadId): UploadSnapshot;
  listProjectTargets(): readonly ProjectTargetSummary[];
  redeemProjectUploadKey(
    input: RedeemProjectUploadKeyInput,
  ): ProjectUploadKeyBinding;
  resolveProjectUploadKeyBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
  }): Omit<ProjectUploadKeyBinding, "deviceId">;
  resumeProjectUpload(input: ResumeProjectUploadInput): UploadSnapshot;
  storageStatus(): Promise<StorageStatus>;
  registerPairedDevice(input: RegisterPairedDeviceInput): void;
  revokeProjectUploadKey(keyId: ProjectUploadKeyId): void;
}

export async function createMaterialLibrary(
  config: MaterialLibraryConfig,
): Promise<MaterialLibrary> {
  const layout = await createMaterialLayout(config.materialRootPath);
  const store = createMaterialLibraryStore(config.databasePath);
  const library = new SqliteMaterialLibrary(
    config.availableBytes,
    layout,
    config.projectUploadNodeId,
    config.projectUploadKeyPepper,
    store,
  );
  await reconcileMaterialLibrary({ layout, store });
  return library;
}
