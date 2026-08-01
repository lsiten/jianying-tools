import { describe, expect, test } from "vitest";

import { resolveRuntimeEnvironment } from "./runtime-environment.js";

describe("runtime environment", () => {
  test("uses the macOS keychain signaling secret to activate deployed public transfer defaults", async () => {
    // Given: a normal local launch with no plaintext settings or local TURN credentials.
    const readStoredSecret = async (): Promise<string | undefined> =>
      "f6huCGp0rlBTLvln2T_KYYooMPECt4x8q6a13QYu6Cg";

    // When: startup resolves its single trusted configuration boundary.
    const environment = await resolveRuntimeEnvironment({
      environment: {},
      readStoredSecret,
    });

    // Then: the secret enters memory for runtime validation without being written to a project file.
    expect(environment.JIANYING_SIGNALING_HMAC_SECRET).toBe(
      "f6huCGp0rlBTLvln2T_KYYooMPECt4x8q6a13QYu6Cg",
    );
  });

  test("keeps an explicitly supplied secret ahead of the keychain", async () => {
    // Given: an intentional environment override and a keychain reader that must not be consulted.
    const environment = {
      JIANYING_SIGNALING_HMAC_SECRET:
        "c9VyL2hJMJ7rexfM06eOOgpMcmbIcno2bPaKuO0z5LQ",
      JIANYING_SIGNALING_WORKER_URL: "https://signal.example.workers.dev",
      JIANYING_STUN_URLS: "stun:stun.example.net:3478",
    };
    const readStoredSecret = async (): Promise<string | undefined> => {
      throw new Error("Keychain reader must not run when a secret is explicit");
    };

    // When: startup resolves the configuration boundary.
    const resolved = await resolveRuntimeEnvironment({
      environment,
      readStoredSecret,
    });

    // Then: it preserves the explicit secret without an external lookup.
    expect(resolved).toBe(environment);
  });
});
