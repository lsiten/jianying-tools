import {
  REMOTE_CONTROL_MESSAGE_TYPES,
  type RemoteControlMacResponse,
} from "@jianying/contracts";

import { ProjectUploadKeyError } from "../uploads/project-upload-key-error.js";
import { StorageReservationError } from "../uploads/upload-errors.js";

export function sendCreateTransferRejection(input: {
  readonly error: unknown;
  readonly requestId: string;
  readonly send: (response: RemoteControlMacResponse) => void;
}): boolean {
  if (input.error instanceof StorageReservationError) {
    input.send({
      code: "STORAGE_RESERVATION_UNAVAILABLE",
      requestId: input.requestId,
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REJECTED,
    });
    return true;
  }
  if (input.error instanceof ProjectUploadKeyError) {
    input.send({
      code: "PROJECT_UPLOAD_KEY_REJECTED",
      requestId: input.requestId,
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REJECTED,
    });
    return true;
  }
  return false;
}

export function sendResumeTransferRejection(input: {
  readonly error: unknown;
  readonly requestId: string;
  readonly send: (response: RemoteControlMacResponse) => void;
}): boolean {
  if (input.error instanceof ProjectUploadKeyError) {
    input.send({
      code: "PROJECT_UPLOAD_KEY_REJECTED",
      requestId: input.requestId,
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REJECTED,
    });
    return true;
  }
  if (input.error instanceof StorageReservationError) {
    input.send({
      code: "TRANSFER_NOT_RESUMABLE",
      requestId: input.requestId,
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REJECTED,
    });
    return true;
  }
  return false;
}
