import { execFile } from "node:child_process";
import { promisify } from "node:util";

const keychainServiceName = "jianying-auto-editor.signaling-hmac";
const executeFile = promisify(execFile);

export type StoredSignalingSecretReader = () => Promise<string | undefined>;

type RuntimeEnvironment = NodeJS.ProcessEnv & {
  readonly JIANYING_SIGNALING_HMAC_SECRET?: string | undefined;
  readonly JIANYING_SIGNALING_WORKER_URL?: string | undefined;
  readonly JIANYING_STUN_URLS?: string | undefined;
  readonly JIANYING_TURN_API_TOKEN?: string | undefined;
  readonly JIANYING_TURN_CREDENTIAL_TTL_SECONDS?: string | undefined;
  readonly JIANYING_TURN_KEY_ID?: string | undefined;
  readonly USER?: string | undefined;
};

export class KeychainSignalingSecretError extends Error {
  readonly name = "KeychainSignalingSecretError";

  constructor() {
    super("Unable to read the local signaling secret from the macOS Keychain");
  }
}

/** Resolves the only startup environment boundary, keeping the shared signaling secret out of files. */
export async function resolveRuntimeEnvironment(input: {
  readonly environment: RuntimeEnvironment;
  readonly readStoredSecret?: StoredSignalingSecretReader;
}): Promise<RuntimeEnvironment> {
  if (input.environment.JIANYING_SIGNALING_HMAC_SECRET !== undefined) {
    return input.environment;
  }
  const storedSecret = await (
    input.readStoredSecret ?? readMacOsKeychainSecret
  )();
  if (storedSecret === undefined) {
    return input.environment;
  }
  return {
    ...input.environment,
    JIANYING_SIGNALING_HMAC_SECRET: storedSecret,
  };
}

/** Reads this installation's HMAC secret only from the macOS Keychain. */
export async function readMacOsKeychainSecret(): Promise<string | undefined> {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const { USER: accountName } = process.env;
  try {
    const { stdout } = await executeFile(
      "security",
      [
        "find-generic-password",
        "-a",
        accountName ?? "",
        "-s",
        keychainServiceName,
        "-w",
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    const secret = stdout.trim();
    return secret.length === 0 ? undefined : secret;
  } catch (error) {
    if (isMissingKeychainItem(error)) {
      return undefined;
    }
    throw new KeychainSignalingSecretError();
  }
}

function isMissingKeychainItem(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 44
  );
}
