import type {
  deviceIdSchema,
  projectUploadKeyIdSchema,
} from "@jianying/contracts";
import type Database from "better-sqlite3";

import type { StoredProjectUploadKey } from "./material-library-store-types.js";
import type {
  ProjectTarget,
  ProjectUploadKey,
} from "./material-library-types.js";

export class SqliteProjectUploadKeyStore {
  constructor(private readonly database: Database.Database) {}

  create(input: {
    readonly directoryName: string;
    readonly keyHash: string;
    readonly keyId: ReturnType<typeof projectUploadKeyIdSchema.parse>;
    readonly target: ProjectTarget;
  }): ProjectUploadKey {
    this.database
      .prepare<[string, string, string, string, string]>(
        "INSERT INTO project_upload_keys (key_id, project_id, category_id, directory_name, key_hash, state) VALUES (?, ?, ?, ?, ?, 'active')",
      )
      .run(
        input.keyId,
        input.target.projectId,
        input.target.categoryId,
        input.directoryName,
        input.keyHash,
      );
    return {
      directoryName: input.directoryName,
      keyId: input.keyId,
      state: "active",
      target: input.target,
    };
  }

  createBinding(input: {
    readonly deviceId: ReturnType<typeof deviceIdSchema.parse>;
    readonly keyId: ReturnType<typeof projectUploadKeyIdSchema.parse>;
  }): void {
    this.database
      .prepare<[string, string]>(
        "INSERT OR IGNORE INTO project_upload_key_bindings (key_id, device_id) VALUES (?, ?)",
      )
      .run(input.keyId, input.deviceId);
  }

  get(
    keyId: ReturnType<typeof projectUploadKeyIdSchema.parse>,
  ): StoredProjectUploadKey | undefined {
    return this.database
      .prepare<[string], StoredProjectUploadKey>(
        "SELECT key_id, project_id, category_id, directory_name, key_hash, state FROM project_upload_keys WHERE key_id = ?",
      )
      .get(keyId);
  }

  hasBinding(input: {
    readonly deviceId: ReturnType<typeof deviceIdSchema.parse>;
    readonly keyId: ReturnType<typeof projectUploadKeyIdSchema.parse>;
  }): boolean {
    return (
      this.database
        .prepare<[string, string], { readonly bound: number }>(
          "SELECT EXISTS(SELECT 1 FROM project_upload_key_bindings WHERE key_id = ? AND device_id = ?) AS bound",
        )
        .get(input.keyId, input.deviceId)?.bound === 1
    );
  }

  revoke(keyId: ReturnType<typeof projectUploadKeyIdSchema.parse>): void {
    this.database
      .prepare<[string]>(
        "UPDATE project_upload_keys SET state = 'revoked' WHERE key_id = ?",
      )
      .run(keyId);
  }
}
