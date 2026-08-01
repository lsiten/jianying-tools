import { type UploadId, uploadIdSchema } from "@jianying/contracts";

import {
  blobPath,
  hashFile,
  type MaterialLayout,
  moveFileWithinMaterialRoot,
  pathExists,
  removeStagingFile,
} from "./material-layout.js";
import type {
  MaterialLibraryStore,
  StoredUpload,
} from "./material-library-store-types.js";
import type {
  CompletedUpload,
  UploadCompletionErrorReason,
} from "./material-library-types.js";
import { persistUploadManifest } from "./material-manifest.js";
import { UploadNotFoundError } from "./upload-errors.js";

export async function completeTransferredUpload(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<CompletedUpload> {
  if (
    BigInt(input.upload.received_bytes) !==
    BigInt(input.upload.expected_size_bytes)
  ) {
    return { kind: "recoverable_error", reason: "UPLOAD_INCOMPLETE" };
  }

  const stagedUpload = await updateStateAndPersist({
    ...input,
    state: "staged",
  });
  const fileHash = await hashFile(stagedUpload.staging_path);
  if (fileHash !== stagedUpload.expected_sha256) {
    return markRecoverableError(
      { ...input, upload: stagedUpload },
      "SHA256_MISMATCH",
    );
  }

  const verifiedUpload = await updateStateAndPersist({
    ...input,
    upload: stagedUpload,
    state: "hash_verified",
  });
  return commitHashVerifiedUpload({ ...input, upload: verifiedUpload });
}

export async function commitHashVerifiedUpload(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<CompletedUpload> {
  const existingBlob = input.store.findBlob(input.upload.expected_sha256);
  const destinationPath =
    existingBlob?.path ?? blobPath(input.layout, input.upload.expected_sha256);
  if (existingBlob !== undefined) {
    if (!(await pathExists(existingBlob.path))) {
      return markRecoverableError(input, "BLOB_MISSING");
    }
    if (await pathExists(input.upload.staging_path)) {
      await removeStagingFile(input.upload.staging_path);
    }
  } else {
    if (!(await pathExists(input.upload.staging_path))) {
      return markRecoverableError(input, "STAGING_FILE_MISSING");
    }
    await moveFileWithinMaterialRoot({
      destinationPath,
      sourcePath: input.upload.staging_path,
    });
  }

  const committedUpload = await updateStateAndPersist({
    ...input,
    state: "committed",
  });
  return finishCommittedUpload({
    ...input,
    upload: committedUpload,
    blobPath: destinationPath,
    createBlob: existingBlob === undefined,
  });
}

export async function finishCommittedUpload(input: {
  readonly blobPath: string;
  readonly createBlob: boolean;
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<CompletedUpload> {
  if (!(await pathExists(input.blobPath))) {
    return markRecoverableError(input, "BLOB_MISSING");
  }
  if ((await hashFile(input.blobPath)) !== input.upload.expected_sha256) {
    return markRecoverableError(input, "SHA256_MISMATCH");
  }
  const { materialId } = input.store.createReadyReference({
    blobPath: input.blobPath,
    createBlob: input.createBlob,
    upload: input.upload,
  });
  const readyUpload = requireUpload(input.store, input.upload.upload_id);
  await persistUploadManifest({
    layout: input.layout,
    store: input.store,
    upload: readyUpload,
  });
  return { kind: "ready", materialId, path: input.blobPath };
}

export async function markRecoverableError(
  input: {
    readonly layout: MaterialLayout;
    readonly store: MaterialLibraryStore;
    readonly upload: StoredUpload;
  },
  reason: UploadCompletionErrorReason,
): Promise<CompletedUpload> {
  await updateStateAndPersist({ ...input, state: "recoverable_error" });
  return { kind: "recoverable_error", reason };
}

export async function updateStateAndPersist(input: {
  readonly layout: MaterialLayout;
  readonly state:
    | "staged"
    | "hash_verified"
    | "committed"
    | "recoverable_error";
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<StoredUpload> {
  const uploadId = uploadIdSchema.parse(input.upload.upload_id);
  input.store.setUploadState(uploadId, input.state);
  const updatedUpload = requireUpload(input.store, input.upload.upload_id);
  await persistUploadManifest({
    layout: input.layout,
    store: input.store,
    upload: updatedUpload,
  });
  return updatedUpload;
}

function requireUpload(
  store: MaterialLibraryStore,
  rawUploadId: string,
): StoredUpload {
  const uploadId: UploadId = uploadIdSchema.parse(rawUploadId);
  const upload = store.getUpload(uploadId);
  if (upload === undefined) {
    throw new UploadNotFoundError(uploadId);
  }
  return upload;
}
