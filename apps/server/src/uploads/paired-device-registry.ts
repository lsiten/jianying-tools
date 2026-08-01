import { createPublicKey } from "node:crypto";
import type { DeviceId } from "@jianying/contracts";
import type { MaterialLibraryStore } from "./material-library-store-types.js";
import type {
  PairedDevice,
  RegisterPairedDeviceInput,
} from "./material-library-types.js";
import { ProjectUploadKeyError } from "./project-upload-key-error.js";

export class PairedDeviceRegistry {
  constructor(private readonly store: MaterialLibraryStore) {}

  get(deviceId: DeviceId): PairedDevice | undefined {
    return this.store.getPairedDevice(deviceId);
  }

  register(input: RegisterPairedDeviceInput): void {
    assertPairedDeviceInput(input);
    this.store.registerPairedDevice(input);
  }

  registerOrVerify(input: RegisterPairedDeviceInput): void {
    const existing = this.get(input.deviceId);
    if (existing === undefined) {
      this.register(input);
      return;
    }
    if (existing.publicKeySpkiBase64Url !== input.publicKeySpkiBase64Url) {
      throw new ProjectUploadKeyError("DEVICE_PUBLIC_KEY_MISMATCH");
    }
  }
}

function assertPairedDeviceInput(input: RegisterPairedDeviceInput): void {
  if (input.displayName.trim().length === 0) {
    throw new PairedDeviceRegistrationError("DISPLAY_NAME_INVALID");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input.publicKeySpkiBase64Url)) {
    throw new PairedDeviceRegistrationError("PUBLIC_KEY_INVALID");
  }
  try {
    const publicKey = createPublicKey({
      format: "der",
      key: Buffer.from(input.publicKeySpkiBase64Url, "base64url"),
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new PairedDeviceRegistrationError("PUBLIC_KEY_INVALID");
    }
  } catch (error) {
    if (error instanceof PairedDeviceRegistrationError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new PairedDeviceRegistrationError("PUBLIC_KEY_INVALID");
    }
    throw new PairedDeviceRegistrationError("PUBLIC_KEY_INVALID");
  }
}

export class PairedDeviceRegistrationError extends Error {
  readonly name = "PairedDeviceRegistrationError";

  constructor(readonly reason: "DISPLAY_NAME_INVALID" | "PUBLIC_KEY_INVALID") {
    super(`Paired device registration failed: ${reason}`);
  }
}
