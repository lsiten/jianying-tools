import {
  DataChunkPacketError,
  decodeDataChunkPacket,
  type TransferControlMessage,
  transferControlMessageSchema,
  type UploadId,
} from "@jianying/contracts";

import {
  StoragePositionUnsupportedError,
  StorageWriteError,
} from "../uploads/material-layout.js";
import type { MaterialLibrary } from "../uploads/material-library.js";
import {
  StorageReservationError,
  UploadIntegrityError,
  UploadNotFoundError,
  UploadStateError,
} from "../uploads/upload-errors.js";

export class TransferControlMessageError extends Error {
  readonly name = "TransferControlMessageError";

  constructor(readonly reason: "CONTROL_JSON_INVALID") {
    super(`Invalid WebRTC transfer control message: ${reason}`);
  }
}

export const TRANSFER_AUTHORIZATION_REJECTION_REASONS = {
  AUTHORIZE_REJECTED: "AUTHORIZE_REJECTED",
  DEVICE_NOT_PAIRED: "DEVICE_NOT_PAIRED",
  DEVICE_PROOF_INVALID: "DEVICE_PROOF_INVALID",
  DTLS_FINGERPRINT_MISMATCH: "DTLS_FINGERPRINT_MISMATCH",
} as const;

export type TransferAuthorizationRejectionReason =
  (typeof TRANSFER_AUTHORIZATION_REJECTION_REASONS)[keyof typeof TRANSFER_AUTHORIZATION_REJECTION_REASONS];

export type TransferAuthorizationResult =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "rejected";
      readonly reason: TransferAuthorizationRejectionReason;
    };

export interface IncomingUploadReceiver {
  receiveControl(serialized: string): Promise<TransferControlMessage>;
  receiveData(packet: Uint8Array): Promise<TransferControlMessage>;
}

export type TransferAuthorization = (
  input: Extract<TransferControlMessage, { readonly type: "authorize" }>,
) => Promise<TransferAuthorizationResult> | TransferAuthorizationResult;

/** Accepts bytes only for an upload already authorized by the pairing and grant layer. */
export function createIncomingUploadReceiver(input: {
  readonly authorize?: TransferAuthorization;
  readonly materialLibrary: MaterialLibrary;
  readonly uploadId: UploadId;
}): IncomingUploadReceiver {
  return new DurableIncomingUploadReceiver(
    input.authorize ?? rejectAuthorization,
    input.materialLibrary,
    input.uploadId,
  );
}

class DurableIncomingUploadReceiver implements IncomingUploadReceiver {
  private authorized = false;

  constructor(
    private readonly authorize: TransferAuthorization,
    private readonly materialLibrary: MaterialLibrary,
    private readonly uploadId: UploadId,
  ) {}

  async receiveData(packet: Uint8Array): Promise<TransferControlMessage> {
    if (!this.authorized) {
      return this.nackCode("AUTHORIZE_REQUIRED");
    }
    try {
      const chunk = decodeDataChunkPacket(packet);
      const acknowledgement = await this.materialLibrary.appendChunk({
        bytes: chunk.payload,
        checksumSha256: chunk.checksumSha256,
        chunkIndex: chunk.chunkIndex,
        offsetBytes: chunk.offsetBytes,
        uploadId: this.uploadId,
      });
      return {
        ackEpoch: acknowledgement.ackEpoch.toString(),
        receivedBytes: acknowledgement.receivedBytes.toString(),
        type: "ack",
        uploadId: this.uploadId,
      };
    } catch (error) {
      return this.nack(error);
    }
  }

  async receiveControl(serialized: string): Promise<TransferControlMessage> {
    const message = parseControlMessage(serialized);
    if (message.uploadId !== this.uploadId) {
      return this.nackCode("UPLOAD_ID_MISMATCH");
    }

    switch (message.type) {
      case "resume":
        return this.acknowledgement();
      case "authorize":
        return this.authorizeTransfer(message);
      case "cancel":
        return this.cancel();
      case "complete":
        return this.complete();
      case "ack":
      case "nack":
      case "pause":
      case "ready":
        return this.nackCode("UNEXPECTED_CONTROL_MESSAGE");
      default:
        return assertNever(message);
    }
  }

  private acknowledgement(): TransferControlMessage {
    const snapshot = this.materialLibrary.getUpload(this.uploadId);
    return {
      ackEpoch: snapshot.ackEpoch.toString(),
      receivedBytes: snapshot.receivedBytes.toString(),
      type: "ack",
      uploadId: this.uploadId,
    };
  }

  private async complete(): Promise<TransferControlMessage> {
    const result = await this.materialLibrary.completeUpload(this.uploadId);
    switch (result.kind) {
      case "ready":
        return {
          materialId: result.materialId,
          type: "ready",
          uploadId: this.uploadId,
        };
      case "recoverable_error":
        return this.nackCode(result.reason);
      default:
        return assertNever(result);
    }
  }

  private async cancel(): Promise<TransferControlMessage> {
    await this.materialLibrary.cancelUpload(this.uploadId);
    return { type: "cancel", uploadId: this.uploadId };
  }

  private async authorizeTransfer(
    message: Extract<TransferControlMessage, { readonly type: "authorize" }>,
  ): Promise<TransferControlMessage> {
    const authorization = await this.authorize(message);
    if (authorization.kind === "rejected") {
      return this.nackCode(authorization.reason);
    }
    this.authorized = true;
    return this.acknowledgement();
  }

  private nack(error: unknown): TransferControlMessage {
    if (error instanceof DataChunkPacketError) {
      return this.nackCode(error.reason);
    }
    if (error instanceof UploadIntegrityError) {
      return this.nackCode(error.reason);
    }
    if (error instanceof UploadStateError) {
      return this.nackCode("UPLOAD_STATE_INVALID");
    }
    if (error instanceof UploadNotFoundError) {
      return this.nackCode("UPLOAD_NOT_FOUND");
    }
    if (error instanceof StorageReservationError) {
      return this.nackCode("STORAGE_RESERVATION_UNAVAILABLE");
    }
    if (error instanceof StoragePositionUnsupportedError) {
      return this.nackCode("STORAGE_POSITION_UNSUPPORTED");
    }
    if (error instanceof StorageWriteError) {
      return this.nackCode("IO_INTERRUPTED");
    }
    throw error;
  }

  private nackCode(code: string): TransferControlMessage {
    return { code, type: "nack", uploadId: this.uploadId };
  }
}

function rejectAuthorization(): TransferAuthorizationResult {
  return { kind: "rejected", reason: "AUTHORIZE_REJECTED" };
}

function parseControlMessage(serialized: string): TransferControlMessage {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TransferControlMessageError("CONTROL_JSON_INVALID");
    }
    throw error;
  }
  return transferControlMessageSchema.parse(rawMessage);
}

function assertNever(_value: never): never {
  throw new TransferControlMessageError("CONTROL_JSON_INVALID");
}
