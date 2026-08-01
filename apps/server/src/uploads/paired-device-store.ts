import { deviceIdSchema } from "@jianying/contracts";
import type Database from "better-sqlite3";

import type {
  PairedDevice,
  RegisterPairedDeviceInput,
} from "./material-library-types.js";

export class SqlitePairedDeviceStore {
  constructor(private readonly database: Database.Database) {}

  get(
    deviceId: ReturnType<typeof deviceIdSchema.parse>,
  ): PairedDevice | undefined {
    const stored = this.database
      .prepare<
        [string],
        {
          readonly device_id: string;
          readonly display_name: string;
          readonly public_key_spki_base64url: string;
        }
      >(
        "SELECT device_id, display_name, public_key_spki_base64url FROM paired_devices WHERE device_id = ?",
      )
      .get(deviceId);
    if (stored === undefined) {
      return undefined;
    }
    return {
      deviceId: deviceIdSchema.parse(stored.device_id),
      displayName: stored.display_name,
      publicKeySpkiBase64Url: stored.public_key_spki_base64url,
    };
  }

  register(input: RegisterPairedDeviceInput): void {
    this.database
      .prepare<[string, string, string]>(
        "INSERT INTO paired_devices (device_id, display_name, public_key_spki_base64url) VALUES (?, ?, ?)",
      )
      .run(input.deviceId, input.displayName, input.publicKeySpkiBase64Url);
  }
}
