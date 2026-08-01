import {
  REMOTE_CONTROL_MESSAGE_TYPES,
  type RemoteControlMacResponse,
  type RemoteControlMobileRequest,
  type UploadId,
} from "@jianying/contracts";

import type { MaterialLibrary } from "../uploads/material-library.js";
import { ProjectUploadKeyError } from "../uploads/project-upload-key-error.js";
import {
  type ProjectUploadKeyControlError,
  reportProjectUploadControlError,
} from "./project-upload-key-control-error.js";
import { assertNever } from "./project-upload-key-control-guards.js";
import {
  sendCreateTransferRejection,
  sendResumeTransferRejection,
} from "./project-upload-transfer-rejection.js";
import type { UploadTransferService } from "./upload-transfer-service.js";

const DEFAULT_MAX_CHUNK_BYTES = 1_048_576;

export { ProjectUploadKeyControlError } from "./project-upload-key-control-error.js";

export interface ProjectUploadKeyControl {
  receive(request: RemoteControlMobileRequest): Promise<void>;
}

/** Bridges Worker-relayed Key redemption and file-session requests to the local, directory-scoped authority. */
export function createProjectUploadKeyControl(input: {
  readonly materialLibrary: Pick<
    MaterialLibrary,
    | "cancelUpload"
    | "createProjectUpload"
    | "redeemProjectUploadKey"
    | "resumeProjectUpload"
  >;
  readonly maxChunkBytes?: number;
  readonly onError?: (error: ProjectUploadKeyControlError) => void;
  readonly send: (response: RemoteControlMacResponse) => void;
  readonly transferService: Pick<UploadTransferService, "create">;
}): ProjectUploadKeyControl {
  return new DefaultProjectUploadKeyControl({
    ...input,
    maxChunkBytes: input.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES,
    onError: input.onError ?? (() => undefined),
  });
}

class DefaultProjectUploadKeyControl implements ProjectUploadKeyControl {
  constructor(
    private readonly input: {
      readonly materialLibrary: Pick<
        MaterialLibrary,
        | "cancelUpload"
        | "createProjectUpload"
        | "redeemProjectUploadKey"
        | "resumeProjectUpload"
      >;
      readonly maxChunkBytes: number;
      readonly onError: (error: ProjectUploadKeyControlError) => void;
      readonly send: (response: RemoteControlMacResponse) => void;
      readonly transferService: Pick<UploadTransferService, "create">;
    },
  ) {}

  async receive(request: RemoteControlMobileRequest): Promise<void> {
    switch (request.type) {
      case REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REQUEST:
        this.redeem(request);
        return;
      case REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REQUEST:
        await this.createTransfer(request);
        return;
      case REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST:
        await this.resumeTransfer(request);
        return;
      default:
        return assertNever(request);
    }
  }

  private redeem(
    request: Extract<
      RemoteControlMobileRequest,
      {
        readonly type: typeof REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REQUEST;
      }
    >,
  ): void {
    try {
      const binding = this.input.materialLibrary.redeemProjectUploadKey({
        deviceId: request.deviceId,
        displayName: request.displayName,
        publicKeySpkiBase64Url: request.publicKeySpkiBase64Url,
        rawKey: request.rawKey,
      });
      this.input.send({
        directoryName: binding.directoryName,
        keyId: binding.keyId,
        requestId: request.requestId,
        target: binding.target,
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_ACCEPTED,
      });
    } catch (error) {
      if (error instanceof ProjectUploadKeyError) {
        this.input.send({
          reason: "PROJECT_UPLOAD_KEY_REJECTED",
          requestId: request.requestId,
          type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REJECTED,
        });
        return;
      }
      throw error;
    }
  }

  private async createTransfer(
    request: Extract<
      RemoteControlMobileRequest,
      {
        readonly type: typeof REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REQUEST;
      }
    >,
  ): Promise<void> {
    let uploadId: UploadId | undefined;
    try {
      const createdUpload =
        await this.input.materialLibrary.createProjectUpload({
          deviceId: request.deviceId,
          expectedSha256: request.expectedSha256,
          expectedSizeBytes: BigInt(request.expectedSizeBytes),
          fileName: request.fileName,
          keyId: request.keyId,
        });
      uploadId = createdUpload.uploadId;
      const session = await this.input.transferService.create({
        deviceId: request.deviceId,
        uploadId,
      });
      this.input.send({
        expiresAtEpochMs: session.expiresAtEpochMs,
        iceServers: [...session.iceServers],
        maxChunkBytes: this.input.maxChunkBytes,
        mobileSignalingToken: session.mobileSignalingToken,
        requestId: request.requestId,
        sessionId: session.sessionId,
        transferGrant: session.transferGrant,
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED,
        uploadId,
      });
    } catch (error) {
      if (uploadId !== undefined) {
        await this.cancelUpload(uploadId);
      }
      this.rejectTransfer(request.requestId, error);
    }
  }

  private async resumeTransfer(
    request: Extract<
      RemoteControlMobileRequest,
      {
        readonly type: typeof REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST;
      }
    >,
  ): Promise<void> {
    try {
      this.input.materialLibrary.resumeProjectUpload({
        deviceId: request.deviceId,
        expectedSha256: request.expectedSha256,
        expectedSizeBytes: BigInt(request.expectedSizeBytes),
        fileName: request.fileName,
        keyId: request.keyId,
        uploadId: request.uploadId,
      });
      const session = await this.input.transferService.create({
        deviceId: request.deviceId,
        uploadId: request.uploadId,
      });
      this.input.send({
        expiresAtEpochMs: session.expiresAtEpochMs,
        iceServers: [...session.iceServers],
        maxChunkBytes: this.input.maxChunkBytes,
        mobileSignalingToken: session.mobileSignalingToken,
        requestId: request.requestId,
        sessionId: session.sessionId,
        transferGrant: session.transferGrant,
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED,
        uploadId: request.uploadId,
      });
    } catch (error) {
      this.rejectResume(request.requestId, error);
    }
  }

  private async cancelUpload(uploadId: UploadId): Promise<void> {
    try {
      await this.input.materialLibrary.cancelUpload(uploadId);
    } catch (error) {
      this.report(error);
    }
  }

  private rejectTransfer(requestId: string, error: unknown): void {
    if (
      sendCreateTransferRejection({
        error,
        requestId,
        send: this.input.send,
      })
    ) {
      return;
    }
    this.report(error);
    this.input.send({
      code: "TRANSFER_SERVICE_UNAVAILABLE",
      requestId,
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REJECTED,
    });
  }

  private rejectResume(requestId: string, error: unknown): void {
    if (
      sendResumeTransferRejection({
        error,
        requestId,
        send: this.input.send,
      })
    ) {
      return;
    }
    this.report(error);
    this.input.send({
      code: "TRANSFER_SERVICE_UNAVAILABLE",
      requestId,
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REJECTED,
    });
  }

  private report(error: unknown): void {
    reportProjectUploadControlError({ error, onError: this.input.onError });
  }
}
