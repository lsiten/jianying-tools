import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  categoryIdSchema,
  projectIdSchema,
  projectUploadKeyIdSchema,
} from "@jianying/contracts";

import type { MaterialLibraryStore } from "./material-library-store-types.js";
import type {
  CreatedProjectUploadKey,
  ProjectTarget,
  ProjectUploadKey,
  ProjectUploadKeyBinding,
  RedeemProjectUploadKeyInput,
} from "./material-library-types.js";
import {
  PairedDeviceRegistrationError,
  type PairedDeviceRegistry,
} from "./paired-device-registry.js";
import { ProjectUploadKeyError } from "./project-upload-key-error.js";

export class ProjectUploadKeyService {
  constructor(
    private readonly deviceRegistry: PairedDeviceRegistry,
    private readonly nodeId: string | undefined,
    private readonly pepper: string | undefined,
    private readonly store: MaterialLibraryStore,
  ) {}

  create(input: {
    readonly directoryName: string;
    readonly target: ProjectTarget;
  }): CreatedProjectUploadKey {
    const { nodeId, pepper } = this.requireConfiguration();
    const directoryName = input.directoryName.trim();
    if (directoryName.length === 0) {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_INVALID");
    }
    const keyId = projectUploadKeyIdSchema.parse(randomUUID());
    const rawKey = createRawKey(nodeId, keyId);
    const uploadKey = this.store.createProjectUploadKey({
      directoryName,
      keyHash: hashRawKey(rawKey, pepper),
      keyId,
      target: input.target,
    });
    return { rawKey, uploadKey };
  }

  redeem(input: RedeemProjectUploadKeyInput): ProjectUploadKeyBinding {
    const { pepper } = this.requireConfiguration();
    const keyId = parseRawKeyId(input.rawKey);
    const stored = this.store.getProjectUploadKey(keyId);
    if (
      stored === undefined ||
      !sameHash(hashRawKey(input.rawKey, pepper), stored.key_hash)
    ) {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_INVALID");
    }
    if (stored.state === "revoked") {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_REVOKED");
    }
    if (stored.state !== "active") {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_INVALID");
    }
    try {
      this.deviceRegistry.registerOrVerify({
        deviceId: input.deviceId,
        displayName: input.displayName,
        publicKeySpkiBase64Url: input.publicKeySpkiBase64Url,
      });
    } catch (error) {
      if (error instanceof PairedDeviceRegistrationError) {
        throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_UNAUTHORIZED");
      }
      throw error;
    }
    this.store.createProjectUploadKeyBinding({
      deviceId: input.deviceId,
      keyId,
    });
    return {
      deviceId: input.deviceId,
      directoryName: stored.directory_name,
      keyId,
      target: {
        categoryId: categoryIdSchema.parse(stored.category_id),
        projectId: projectIdSchema.parse(stored.project_id),
      },
    };
  }

  resolveBinding(input: {
    readonly deviceId: ProjectUploadKeyBinding["deviceId"];
    readonly keyId: ProjectUploadKeyBinding["keyId"];
  }): Omit<ProjectUploadKeyBinding, "deviceId"> {
    this.requireConfiguration();
    const stored = this.store.getProjectUploadKey(input.keyId);
    if (stored === undefined) {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_INVALID");
    }
    if (stored.state === "revoked") {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_REVOKED");
    }
    if (
      stored.state !== "active" ||
      !this.store.hasProjectUploadKeyBinding(input)
    ) {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_UNAUTHORIZED");
    }
    return {
      directoryName: stored.directory_name,
      keyId: input.keyId,
      target: {
        categoryId: categoryIdSchema.parse(stored.category_id),
        projectId: projectIdSchema.parse(stored.project_id),
      },
    };
  }

  revoke(keyId: ProjectUploadKey["keyId"]): void {
    this.requireConfiguration();
    this.store.revokeProjectUploadKey(keyId);
  }

  private requireConfiguration(): {
    readonly nodeId: string;
    readonly pepper: string;
  } {
    if (
      this.nodeId === undefined ||
      !/^[A-Za-z0-9_-]{22}$/.test(this.nodeId) ||
      this.pepper === undefined ||
      this.pepper.length === 0
    ) {
      throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_UNAVAILABLE");
    }
    return { nodeId: this.nodeId, pepper: this.pepper };
  }
}

function createRawKey(
  nodeId: string,
  keyId: ProjectUploadKey["keyId"],
): string {
  return `jyup1.${nodeId}.${keyId}.${randomBytes(32).toString("base64url")}`;
}

function parseRawKeyId(rawKey: string): ProjectUploadKey["keyId"] {
  const parts = rawKey.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "jyup1" ||
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[3] === undefined ||
    !/^[A-Za-z0-9_-]{22}$/.test(parts[1]) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[3])
  ) {
    throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_INVALID");
  }
  const parsed = projectUploadKeyIdSchema.safeParse(parts[2]);
  if (!parsed.success) {
    throw new ProjectUploadKeyError("PROJECT_UPLOAD_KEY_INVALID");
  }
  return parsed.data;
}

function hashRawKey(rawKey: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update("jianying-project-upload-key-v1", "utf8")
    .update(rawKey, "utf8")
    .digest("base64url");
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
