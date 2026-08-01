import { uploadIdSchema } from "@jianying/contracts";

import {
  type MaterialLayout,
  manifestPath,
  writeManifestAtomically,
} from "./material-layout.js";
import type {
  MaterialLibraryStore,
  StoredUpload,
} from "./material-library-store-types.js";

/** Mirrors the SQLite upload state only after its preceding durable database mutation. */
export async function persistUploadManifest(input: {
  readonly layout: MaterialLayout;
  readonly store: MaterialLibraryStore;
  readonly upload: StoredUpload;
}): Promise<void> {
  const uploadId = uploadIdSchema.parse(input.upload.upload_id);
  const chunks = input.store.getChunks(uploadId);
  await writeManifestAtomically({
    manifest: JSON.stringify({ ...input.upload, chunks }),
    path: manifestPath(input.layout, uploadId),
  });
}
