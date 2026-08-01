import {
  controlNodeIdSchema,
  type DeviceId,
  deviceIdSchema,
  type ProjectUploadKeyId,
  projectUploadKeyIdSchema,
  type UploadId,
  uploadIdSchema,
} from "@jianying/contracts";
import { z } from "zod";

import { SerialTaskQueue } from "./serial-task-queue.js";

const DATABASE_NAME = "jianying-mobile-upload";
const DATABASE_VERSION = 2;
const STATE_STORE = "state";
const IDENTITY_KEY = "identity";
const BINDINGS_KEY = "bindings";
const SELECTED_KEY_ID = "selected-key-id";
const RESUMABLE_UPLOADS_KEY = "resumable-uploads";

const persistedBindingSchema = z
  .object({
    directoryName: z.string().min(1),
    keyId: projectUploadKeyIdSchema,
    nodeId: controlNodeIdSchema,
  })
  .strict();

const persistedBindingsSchema = z.array(persistedBindingSchema);

export type PairedUploadDestination = z.infer<typeof persistedBindingSchema>;

const resumableUploadSchema = persistedBindingSchema.extend({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileName: z.string().min(1).max(255),
  // Kept permissive solely to read resumable records from older app versions.
  pausedReason: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  uploadId: uploadIdSchema,
});

const resumableUploadsSchema = z.array(resumableUploadSchema);

export type ResumableMobileUpload = z.infer<typeof resumableUploadSchema>;

export type MobileIdentity = {
  readonly deviceId: DeviceId;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
};

const persistedIdentityMetadataSchema = z
  .object({
    deviceId: deviceIdSchema,
    privateKey: z.unknown(),
    publicKey: z.unknown(),
  })
  .strict();

export class MobileStateError extends Error {
  readonly name = "MobileStateError";

  constructor(
    readonly reason:
      | "IDENTITY_UNAVAILABLE"
      | "INDEXED_DB_UNAVAILABLE"
      | "STATE_INVALID",
  ) {
    super(`Mobile upload state failed: ${reason}`);
  }
}

/** Stores only the browser device identity and redeemed destination metadata; raw desktop Keys never enter IndexedDB. */
export class MobileUploadState {
  private readonly resumableUploadMutations = new SerialTaskQueue();

  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<MobileUploadState> {
    if (typeof indexedDB === "undefined") {
      throw new MobileStateError("INDEXED_DB_UNAVAILABLE");
    }
    return new MobileUploadState(await openDatabase());
  }

  async getOrCreateIdentity(): Promise<MobileIdentity> {
    const existing = await this.get(IDENTITY_KEY);
    if (existing !== undefined) {
      return parseIdentity(existing);
    }
    const generated = await generateIdentity();
    await this.put(IDENTITY_KEY, generated);
    return generated;
  }

  async listDestinations(): Promise<readonly PairedUploadDestination[]> {
    const stored = await this.get(BINDINGS_KEY);
    if (stored === undefined) {
      return [];
    }
    const parsed = persistedBindingsSchema.safeParse(stored);
    if (!parsed.success) {
      throw new MobileStateError("STATE_INVALID");
    }
    return parsed.data;
  }

  async selectedDestinationKeyId(): Promise<ProjectUploadKeyId | undefined> {
    const stored = await this.get(SELECTED_KEY_ID);
    if (stored === undefined) {
      return undefined;
    }
    const parsed = projectUploadKeyIdSchema.safeParse(stored);
    if (!parsed.success) {
      throw new MobileStateError("STATE_INVALID");
    }
    return parsed.data;
  }

  async selectDestination(keyId: ProjectUploadKeyId): Promise<void> {
    const destinations = await this.listDestinations();
    if (!destinations.some((destination) => destination.keyId === keyId)) {
      throw new MobileStateError("STATE_INVALID");
    }
    await this.put(SELECTED_KEY_ID, keyId);
  }

  async saveDestination(
    destination: PairedUploadDestination,
  ): Promise<readonly PairedUploadDestination[]> {
    const destinations = await this.listDestinations();
    const next = [
      destination,
      ...destinations.filter(
        (candidate) => candidate.keyId !== destination.keyId,
      ),
    ];
    await this.put(BINDINGS_KEY, next);
    return next;
  }

  async listResumableUploads(): Promise<readonly ResumableMobileUpload[]> {
    const stored = await this.get(RESUMABLE_UPLOADS_KEY);
    if (stored === undefined) {
      return [];
    }
    const parsed = resumableUploadsSchema.safeParse(stored);
    if (!parsed.success) {
      throw new MobileStateError("STATE_INVALID");
    }
    return parsed.data;
  }

  async saveResumableUpload(input: ResumableMobileUpload): Promise<void> {
    await this.resumableUploadMutations.enqueue(async () => {
      const uploads = await this.listResumableUploads();
      await this.put(RESUMABLE_UPLOADS_KEY, [
        input,
        ...uploads.filter((upload) => upload.uploadId !== input.uploadId),
      ]);
    });
  }

  async removeResumableUpload(uploadId: UploadId): Promise<void> {
    await this.resumableUploadMutations.enqueue(async () => {
      const uploads = await this.listResumableUploads();
      await this.put(
        RESUMABLE_UPLOADS_KEY,
        uploads.filter((upload) => upload.uploadId !== uploadId),
      );
    });
  }

  private async get(key: string): Promise<unknown | undefined> {
    const transaction = this.database.transaction(STATE_STORE, "readonly");
    const request = transaction.objectStore(STATE_STORE).get(key);
    return requestResult(request);
  }

  private async put(key: string, value: unknown): Promise<void> {
    const transaction = this.database.transaction(STATE_STORE, "readwrite");
    transaction.objectStore(STATE_STORE).put(value, key);
    await transactionComplete(transaction);
  }
}

export function exportPublicKeySpkiBase64Url(
  identity: MobileIdentity,
): Promise<string> {
  return crypto.subtle.exportKey("spki", identity.publicKey).then(toBase64Url);
}

export function signWithMobileIdentity(
  identity: MobileIdentity,
  payload: Uint8Array,
): Promise<string> {
  const stablePayload = Uint8Array.from(payload);
  return crypto.subtle
    .sign({ name: "Ed25519" }, identity.privateKey, stablePayload)
    .then(toBase64Url);
}

async function generateIdentity(): Promise<MobileIdentity> {
  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      false,
      ["sign", "verify"],
    );
    if (
      !(keyPair.privateKey instanceof CryptoKey) ||
      !(keyPair.publicKey instanceof CryptoKey)
    ) {
      throw new MobileStateError("IDENTITY_UNAVAILABLE");
    }
    return {
      deviceId: deviceIdSchema.parse(crypto.randomUUID()),
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
    };
  } catch (error) {
    if (error instanceof MobileStateError) {
      throw error;
    }
    throw new MobileStateError("IDENTITY_UNAVAILABLE");
  }
}

function parseIdentity(value: unknown): MobileIdentity {
  const metadata = persistedIdentityMetadataSchema.safeParse(value);
  if (!metadata.success) {
    throw new MobileStateError("STATE_INVALID");
  }
  const privateKey = metadata.data.privateKey;
  const publicKey = metadata.data.publicKey;
  if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof CryptoKey)) {
    throw new MobileStateError("STATE_INVALID");
  }
  return { deviceId: metadata.data.deviceId, privateKey, publicKey };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STATE_STORE)) {
        request.result.createObjectStore(STATE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new MobileStateError("INDEXED_DB_UNAVAILABLE"));
  });
}

function requestResult(
  request: IDBRequest<unknown>,
): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new MobileStateError("INDEXED_DB_UNAVAILABLE"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(new MobileStateError("INDEXED_DB_UNAVAILABLE"));
    transaction.onabort = () =>
      reject(new MobileStateError("INDEXED_DB_UNAVAILABLE"));
  });
}

function toBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
