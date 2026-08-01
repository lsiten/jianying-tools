export class ProjectUploadKeyControlError extends Error {
  readonly name = "ProjectUploadKeyControlError";

  constructor(readonly reason: "TRANSFER_REQUEST_FAILED") {
    super(`Project upload Key control failed: ${reason}`);
  }
}

export function reportProjectUploadControlError(input: {
  readonly error: unknown;
  readonly onError: (error: ProjectUploadKeyControlError) => void;
}): void {
  input.onError(
    input.error instanceof ProjectUploadKeyControlError
      ? input.error
      : new ProjectUploadKeyControlError("TRANSFER_REQUEST_FAILED"),
  );
}
