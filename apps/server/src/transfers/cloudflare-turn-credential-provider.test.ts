import { describe, expect, test, vi } from "vitest";

import {
  type CloudflareTurnCredentialError,
  createCloudflareTurnCredentialProvider,
} from "./cloudflare-turn-credential-provider.js";

describe("Cloudflare TURN credential provider", () => {
  test("mints per-session credentials, filters browser-blocked port 53, and never returns the long-term API token", async () => {
    // Given: the local server owns the paid TURN key and Cloudflare returns its complete ICE list.
    const requestCredentials = vi.fn(async () => ({
      iceServers: [
        {
          urls: [
            "stun:stun.cloudflare.com:3478",
            "stun:stun.cloudflare.com:53",
          ],
        },
        {
          credential: "short-lived-password",
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:53?transport=udp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "short-lived-user",
        },
      ],
    }));
    const provider = createCloudflareTurnCredentialProvider({
      apiToken: "long-term-api-token",
      keyId: "turn-key-id",
      requestCredentials,
      ttlSeconds: 86_400,
    });

    // When: one upload session requests its exact ICE configuration.
    const iceServers = await provider.resolveIceServers();

    // Then: the browser receives only usable short-lived credentials and no :53 route.
    expect(requestCredentials).toHaveBeenCalledWith({
      apiToken: "long-term-api-token",
      keyId: "turn-key-id",
      ttlSeconds: 86_400,
    });
    expect(iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        credential: "short-lived-password",
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "short-lived-user",
      },
    ]);
    expect(JSON.stringify(iceServers)).not.toContain("long-term-api-token");
  });

  test("fails closed when Cloudflare returns no usable relay endpoint", async () => {
    // Given: the credential API response only contains an unusable browser port.
    const provider = createCloudflareTurnCredentialProvider({
      apiToken: "long-term-api-token",
      keyId: "turn-key-id",
      requestCredentials: async () => ({
        iceServers: [
          {
            credential: "short-lived-password",
            urls: ["turn:turn.cloudflare.com:53?transport=udp"],
            username: "short-lived-user",
          },
        ],
      }),
      ttlSeconds: 86_400,
    });

    // Then: incomplete relay settings cannot silently fall back to an unsafe route.
    await expect(provider.resolveIceServers()).rejects.toEqual(
      expect.objectContaining<Partial<CloudflareTurnCredentialError>>({
        reason: "CREDENTIAL_RESPONSE_INVALID",
      }),
    );
  });
});
