import { describe, expect, test } from "vitest";

import { loadRuntimeConfig } from "./runtime-config.js";

describe("runtime configuration", () => {
  test("keeps external signaling disabled until every required setting is configured", () => {
    // Given: a fresh local installation with no Cloudflare or STUN settings.
    const config = loadRuntimeConfig({
      JIANYING_DATA_DIRECTORY: "/tmp/jianying-runtime-config-test",
    });

    // When: the server resolves its startup configuration.
    const signaling = config.signaling;

    // Then: the local API can run but cannot mint a publicly routable transfer capability.
    expect(signaling).toEqual({ kind: "disabled" });
  });

  test("enables signaling with configured STUN and the deployed TURN policy when its complete local configuration is present", () => {
    // Given: a locally stored Worker secret and explicit direct ICE URLs.
    const config = loadRuntimeConfig({
      JIANYING_DATA_DIRECTORY: "/tmp/jianying-runtime-config-test",
      JIANYING_SIGNALING_HMAC_SECRET:
        "c9VyL2hJMJ7rexfM06eOOgpMcmbIcno2bPaKuO0z5LQ",
      JIANYING_SIGNALING_WORKER_URL: "https://signal.example.workers.dev",
      JIANYING_STUN_URLS: "stun:stun.example.net:3478",
    });

    // When: the server resolves its startup configuration.
    const signaling = config.signaling;

    // Then: it receives all it needs for direct WebRTC and Worker-minted TURN credentials.
    expect(signaling).toEqual(
      expect.objectContaining({
        connectTimeoutMs: 10_000,
        baseIceServers: [{ urls: ["stun:stun.example.net:3478"] }],
        kind: "enabled",
        nodeId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        signalingSecret: "c9VyL2hJMJ7rexfM06eOOgpMcmbIcno2bPaKuO0z5LQ",
        tokenLifetimeMs: 300_000,
        turn: { ttlSeconds: 86_400 },
        workerBaseUrl: "https://signal.example.workers.dev",
      }),
    );
  });

  test("uses the deployed Cloudflare defaults when this Mac already has its signaling secret", () => {
    // Given: the desktop has already been paired with the deployed signaling Worker.
    const config = loadRuntimeConfig({
      JIANYING_SIGNALING_HMAC_SECRET:
        "c9VyL2hJMJ7rexfM06eOOgpMcmbIcno2bPaKuO0z5LQ",
    });

    // When: startup resolves the public-transfer configuration without local TURN credentials.
    const signaling = config.signaling;

    // Then: the Worker route, STUN baseline, and paid TURN policy are ready after every restart.
    expect(signaling).toMatchObject({
      baseIceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      kind: "enabled",
      turn: { ttlSeconds: 86_400 },
      workerBaseUrl: "https://upload.lene.fun",
    });
  });

  test("rejects partial signaling or unsupported local Cloudflare TURN credentials", () => {
    // Given: environment values that cannot satisfy the remote-transfer boundary.
    const partial = {
      JIANYING_SIGNALING_WORKER_URL: "https://signal.example.workers.dev",
    };
    const localTurnCredential = {
      JIANYING_SIGNALING_HMAC_SECRET:
        "c9VyL2hJMJ7rexfM06eOOgpMcmbIcno2bPaKuO0z5LQ",
      JIANYING_SIGNALING_WORKER_URL: "https://signal.example.workers.dev",
      JIANYING_STUN_URLS: "stun:stun.example.net:3478",
      JIANYING_TURN_KEY_ID: "turn-key-id",
    };

    // When: the local process validates startup settings.
    const resolvePartial = () => loadRuntimeConfig(partial);
    const resolveLocalTurnCredential = () =>
      loadRuntimeConfig(localTurnCredential);

    // Then: it fails closed instead of silently enabling a partial credential route.
    expect(resolvePartial).toThrow(
      expect.objectContaining({ reason: "SIGNALING_CONFIGURATION_INCOMPLETE" }),
    );
    expect(resolveLocalTurnCredential).toThrow(
      expect.objectContaining({
        reason: "TURN_LOCAL_CREDENTIALS_UNSUPPORTED",
      }),
    );
  });

  test("enables paid Cloudflare TURN through the Worker without local long-term credentials", () => {
    // Given: a complete local signaling setup and only the non-secret TTL policy.
    const config = loadRuntimeConfig({
      JIANYING_SIGNALING_HMAC_SECRET:
        "c9VyL2hJMJ7rexfM06eOOgpMcmbIcno2bPaKuO0z5LQ",
      JIANYING_SIGNALING_WORKER_URL: "https://signal.example.workers.dev",
      JIANYING_STUN_URLS: "stun:stun.example.net:3478",
      JIANYING_TURN_CREDENTIAL_TTL_SECONDS: "172800",
    });

    // Then: runtime can mint per-session settings without retaining a Cloudflare TURN token.
    expect(config.signaling).toMatchObject({
      kind: "enabled",
      turn: {
        ttlSeconds: 172_800,
      },
    });
  });
});
