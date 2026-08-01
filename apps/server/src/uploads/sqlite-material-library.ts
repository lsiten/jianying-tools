import { randomUUID } from "node:crypto";
import {
  type DeviceId,
  type ProjectUploadKeyId,
  type UploadId,
  uploadIdSchema,
  uploadStateSchema,
} from "@jianying/contracts";
import { assessUploadAdmission } from "@jianying/domain";

import {
  ensureEmptyStagingFile,
  type MaterialLayout,
  removeStagingFile,
  stagingPath,
  writeChunkAtOffset,
} from "./material-layout.js";
import type { MaterialLibrary } from "./material-library.js";
import type {
  MaterialLibraryStore,
  StoredUpload,
} from "./material-library-store-types.js";
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
import { persistUploadManifest } from "./material-manifest.js";
import { completeTransferredUpload } from "./material-upload-commit.js";
import {
  assertChunkFits,
  assertChunkMatches,
  assertDuplicateMatches,
  assertTransferring,
} from "./material-upload-guards.js";
import { PairedDeviceRegistry } from "./paired-device-registry.js";
import { ProjectUploadKeyError } from "./project-upload-key-error.js";
import { ProjectUploadKeyService } from "./project-upload-key-service.js";
import {
  StorageReservationError,
  UploadNotFoundError,
} from "./upload-errors.js";
import {
  CreationOperationQueue,
  UploadOperationQueue,
} from "./upload-operation-queue.js";

export class SqliteMaterialLibrary implements MaterialLibrary {
  private readonly creationQueue = new CreationOperationQueue();
  private readonly pairedDevices: PairedDeviceRegistry;
  private readonly projectUploadKeys: ProjectUploadKeyService;
  private readonly uploadOperations = new UploadOperationQueue();

  constructor(
    private readonly availableBytes: () => Promise<bigint>,
    private readonly layout: MaterialLayout,
    projectUploadNodeId: string | undefined,
    projectUploadKeyPepper: string | undefined,
    private readonly store: MaterialLibraryStore,
  ) {
    this.pairedDevices = new PairedDeviceRegistry(store);
    this.projectUploadKeys = new ProjectUploadKeyService(
      this.pairedDevices,
      projectUploadNodeId,
      projectUploadKeyPepper,
      store,
    );
  }

  createProjectTarget(input: CreateProjectTargetInput): ProjectTarget {
    return this.store.createProjectTarget(input);
  }

  createProjectUploadKey(input: {
    readonly directoryName: string;
    readonly target: ProjectTarget;
  }): CreatedProjectUploadKey {
    return this.projectUploadKeys.create(input);
  }

  async createUpload(input: CreateUploadInput): Promise<CreatedUpload> {
    return this.creationQueue.run(async () =>
      this.createUploadExclusive(input),
    );
  }

  async createProjectUpload(
    input: CreateProjectUploadInput,
  ): Promise<CreatedUpload> {
    const binding = this.resolveProjectUploadKeyBinding(input);
    return this.creationQueue.run(async () => {
      const created = await this.createUploadExclusive({
        expectedSha256: input.expectedSha256,
        expectedSizeBytes: input.expectedSizeBytes,
        fileName: input.fileName,
        target: binding.target,
      });
      this.store.createProjectUploadTransferBinding({
        deviceId: input.deviceId,
        keyId: input.keyId,
        uploadId: created.uploadId,
      });
      return created;
    });
  }

  async appendChunk(input: AppendChunkInput): Promise<ChunkAcknowledgement> {
    return this.uploadOperations.run(input.uploadId, async () =>
      this.appendChunkExclusive(input),
    );
  }

  async completeUpload(uploadId: UploadId): Promise<CompletedUpload> {
    return this.uploadOperations.run(uploadId, async () =>
      this.completeUploadExclusive(uploadId),
    );
  }

  async cancelUpload(uploadId: UploadId): Promise<void> {
    return this.uploadOperations.run(uploadId, async () =>
      this.cancelUploadExclusive(uploadId),
    );
  }

  getUpload(uploadId: UploadId): UploadSnapshot {
    const upload = this.requireUpload(uploadId);
    return {
      ackEpoch: BigInt(upload.ack_epoch),
      receivedBytes: BigInt(upload.received_bytes),
      state: uploadStateSchema.parse(upload.state),
      uploadId,
    };
  }

  getPairedDevice(deviceId: DeviceId): PairedDevice | undefined {
    return this.pairedDevices.get(deviceId);
  }

  listProjectTargets(): readonly ProjectTargetSummary[] {
    return this.store.listProjectTargets();
  }

  async storageStatus(): Promise<StorageStatus> {
    return {
      availableBytes: await this.availableBytes(),
      reservedBytes: this.store.reservedUploadBytes(),
    };
  }

  registerPairedDevice(input: RegisterPairedDeviceInput): void {
    this.pairedDevices.register(input);
  }

  redeemProjectUploadKey(
    input: RedeemProjectUploadKeyInput,
  ): ProjectUploadKeyBinding {
    return this.projectUploadKeys.redeem(input);
  }

  resolveProjectUploadKeyBinding(input: {
    readonly deviceId: DeviceId;
    readonly keyId: ProjectUploadKeyId;
  }): Omit<ProjectUploadKeyBinding, "deviceId"> {
    return this.projectUploadKeys.resolveBinding(input);
  }

  resumeProjectUpload(input: ResumeProjectUploadInput): UploadSnapshot {
    this.resolveProjectUploadKeyBinding(input);
    const authorization = this.store.getProjectUploadTransferBinding(
      input.uploadId,
    );
    const upload = this.requireUpload(input.uploadId);
    if (
      authorization?.device_id !== input.deviceId ||
      authorization.key_id !== input.keyId ||
      upload.expected_sha256 !== input.expectedSha256 ||
      upload.expected_size_bytes !== input.expectedSizeBytes.toString() ||
      upload.file_name !== input.fileName ||
      upload.state !== "transferring"
    ) {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_UNAUTHORIZED");
    }
    return {
      ackEpoch: BigInt(upload.ack_epoch),
      receivedBytes: BigInt(upload.received_bytes),
      state: uploadStateSchema.parse(upload.state),
      uploadId: input.uploadId,
    };
  }

  revokeProjectUploadKey(keyId: ProjectUploadKeyId): void {
    this.projectUploadKeys.revoke(keyId);
  }

  countBlobs(): number {
    return this.store.countBlobs();
  }

  countMaterialReferences(): number {
    return this.store.countMaterialReferences();
  }

  close(): void {
    this.store.close();
  }

  private async createUploadExclusive(
    input: CreateUploadInput,
  ): Promise<CreatedUpload> {
    const reservedBytes = this.store.reservedUploadBytes();
    const admission = assessUploadAdmission({
      availableBytes: await this.availableBytes(),
      fileBytes: input.expectedSizeBytes,
      reservedBytes,
    });
    if (admission.kind === "rejected") {
      throw new StorageReservationError(input.expectedSizeBytes);
    }
    const uploadId = uploadIdSchema.parse(randomUUID());
    const stagedPath = stagingPath(this.layout, uploadId);
    await ensureEmptyStagingFile(stagedPath);
    this.store.createUploadRecord({
      categoryId: input.target.categoryId,
      expectedSha256: input.expectedSha256,
      expectedSizeBytes: input.expectedSizeBytes,
      fileName: input.fileName,
      projectId: input.target.projectId,
      stagingPath: stagedPath,
      uploadId,
    });
    await persistUploadManifest({
      layout: this.layout,
      store: this.store,
      upload: this.requireUpload(uploadId),
    });
    return { uploadId };
  }

  private async appendChunkExclusive(
    input: AppendChunkInput,
  ): Promise<ChunkAcknowledgement> {
    const upload = this.requireUpload(input.uploadId);
    assertTransferring(input.uploadId, upload.state);
    assertChunkMatches(input);
    const existingChunks = this.store.getChunks(input.uploadId);
    const duplicate = existingChunks.find(
      (chunk) => chunk.chunk_index === input.chunkIndex.toString(),
    );
    if (duplicate !== undefined) {
      assertDuplicateMatches(input, duplicate);
      return this.acknowledgement(upload);
    }
    assertChunkFits(input, upload, existingChunks);
    await writeChunkAtOffset({
      bytes: input.bytes,
      offsetBytes: input.offsetBytes,
      path: upload.staging_path,
    });
    const acknowledgement = this.store.persistChunk({
      checksumSha256: input.checksumSha256,
      chunkIndex: input.chunkIndex,
      offsetBytes: input.offsetBytes,
      sizeBytes: BigInt(input.bytes.byteLength),
      uploadId: input.uploadId,
    });
    await persistUploadManifest({
      layout: this.layout,
      store: this.store,
      upload: this.requireUpload(input.uploadId),
    });
    return acknowledgement;
  }

  private async completeUploadExclusive(
    uploadId: UploadId,
  ): Promise<CompletedUpload> {
    const upload = this.requireUpload(uploadId);
    assertTransferring(uploadId, upload.state);
    return completeTransferredUpload({
      layout: this.layout,
      store: this.store,
      upload,
    });
  }

  private async cancelUploadExclusive(uploadId: UploadId): Promise<void> {
    const upload = this.requireUpload(uploadId);
    assertTransferring(uploadId, upload.state);
    this.store.setUploadState(uploadId, "cancelled");
    await persistUploadManifest({
      layout: this.layout,
      store: this.store,
      upload: this.requireUpload(uploadId),
    });
    await removeStagingFile(upload.staging_path);
  }

  private acknowledgement(upload: StoredUpload): ChunkAcknowledgement {
    return {
      ackEpoch: BigInt(upload.ack_epoch),
      kind: "acknowledged",
      receivedBytes: BigInt(upload.received_bytes),
    };
  }

  private requireUpload(uploadId: UploadId): StoredUpload {
    const upload = this.store.getUpload(uploadId);
    if (upload === undefined) {
      throw new UploadNotFoundError(uploadId);
    }
    return upload;
  }
}
