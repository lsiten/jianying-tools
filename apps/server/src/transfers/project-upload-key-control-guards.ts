import { ProjectUploadKeyControlError } from "./project-upload-key-control-error.js";

export function assertNever(_value: never): never {
  throw new ProjectUploadKeyControlError("TRANSFER_REQUEST_FAILED");
}
