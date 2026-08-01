import { uploadIdSchema, uploadStateSchema } from "@jianying/contracts";

import {
  blobPath,
  hashFile,
  type MaterialLayout,
  pathExists,
  removeStagingFile,
} from "./material-layout.js";
import type {
  MaterialLibraryStore,
  StoredUpload,
} from "./material-library-store-types.js";
import { persistUploadManifest } from "./material-manifest.js";
import {
  commitHashVerifiedUpload,
  finishCommittedUpload,
  markRecoverableError,
  updateStateAndPersist,
} from "./material-upload-commit.js";
import { UploadStateError } from "./upload-errors.js";

/** Reconciles every persisted upload before the local server accepts new work. */
export async function reconcileMaterialLibrary(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
}): Promise<void> {
  for (const upload of input.store.listUploads()) {
    await reconcileUpload({ ...input, upload });
  }
}

async function reconcileUpload(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<void> {
  const state = uploadStateSchema.parse(input.upload.state);
  switch (state) {
    case "transferring":
      if (!(await pathExists(input.upload.staging_path))) {
        await markRecoverableError(input, "STAGING_FILE_MISSING");
        return;
      }
      await persistUploadManifest(input);
      return;
    case "staged":
      await reconcileStagedUpload(input);
      return;
    case "hash_verified":
      await reconcileVerifiedUpload(input);
      return;
    case "committed":
      await reconcileCommittedUpload(input);
      return;
    case "ready":
    case "recoverable_error":
      await persistUploadManifest(input);
      return;
    case "cancelled":
      await removeStagingFile(input.upload.staging_path);
      await persistUploadManifest(input);
      return;
    default:
      throw new UploadStateError(
        uploadIdSchema.parse(input.upload.upload_id),
        state,
      );
  }
}

async function reconcileStagedUpload(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<void> {
  if (!(await pathExists(input.upload.staging_path))) {
    await markRecoverableError(input, "STAGING_FILE_MISSING");
    return;
  }
  const fileHash = await hashFile(input.upload.staging_path);
  if (fileHash !== input.upload.expected_sha256) {
    await markRecoverableError(input, "SHA256_MISMATCH");
    return;
  }
  const verifiedUpload = await updateStateAndPersist({
    ...input,
    state: "hash_verified",
  });
  await commitHashVerifiedUpload({ ...input, upload: verifiedUpload });
}

async function reconcileVerifiedUpload(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<void> {
  if (await pathExists(input.upload.staging_path)) {
    const fileHash = await hashFile(input.upload.staging_path);
    if (fileHash !== input.upload.expected_sha256) {
      await markRecoverableError(input, "SHA256_MISMATCH");
      return;
    }
    await commitHashVerifiedUpload(input);
    return;
  }

  const finalBlobPath = blobPath(input.layout, input.upload.expected_sha256);
  if (!(await pathExists(finalBlobPath))) {
    await markRecoverableError(input, "STAGING_FILE_MISSING");
    return;
  }
  const committedUpload = await updateStateAndPersist({
    ...input,
    state: "committed",
  });
  await finishCommittedUpload({
    ...input,
    blobPath: finalBlobPath,
    createBlob:
      input.store.findBlob(input.upload.expected_sha256) === undefined,
    upload: committedUpload,
  });
}

async function reconcileCommittedUpload(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<void> {
  const finalBlobPath =
    input.store.findBlob(input.upload.expected_sha256)?.path ??
    blobPath(input.layout, input.upload.expected_sha256);
  await finishCommittedUpload({
    ...input,
    blobPath: finalBlobPath,
    createBlob:
      input.store.findBlob(input.upload.expected_sha256) === undefined,
  });
}
