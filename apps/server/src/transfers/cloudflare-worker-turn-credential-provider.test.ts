import { describe, expect, test, vi } from "vitest";

import { createCloudflareWorkerTurnCredentialProvider } from "./cloudflare-worker-turn-credential-provider.js";

describe("Cloudflare Worker TURN credential provider", () => {
  test("requests short-lived ICE settings through the authenticated Worker without a local TURN API token", async () => {
    // Given: a configured public Worker and this Mac's shared signaling secret.
    const requestCredentials = vi.fn(async () => ({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        {
          credential: "short-lived-credential",
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "short-lived-username",
        },
      ],
    }));
    const provider = createCloudflareWorkerTurnCredentialProvider({
      nodeId: "t7NHTBv9_MpK3VxW6RzQ2A",
      nowEpochMs: () => 1_700_000_000_000,
      requestCredentials,
      secret: "local-signaling-secret",
      ttlSeconds: 86_400,
      workerBaseUrl: "https://signal.example.workers.dev",
    });

    // When: one upload session resolves its ICE configuration.
    const iceServers = await provider.resolveIceServers();

    // Then: the Worker receives a scoped signed request and only short-lived settings return.
    expect(iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        credential: "short-lived-credential",
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "short-lived-username",
      },
    ]);
    expect(requestCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { ttl: 86_400 },
        url: expect.stringMatching(
          /^https:\/\/signal\.example\.workers\.dev\/v1\/turn\/t7NHTBv9_MpK3VxW6RzQ2A\?token=/,
        ),
      }),
    );
    expect(JSON.stringify(requestCredentials.mock.calls)).not.toContain(
      "worker-only-turn-api-token",
    );
  });
});
