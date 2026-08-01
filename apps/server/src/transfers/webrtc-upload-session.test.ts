import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeDataChunkPacket,
  type TransferControlMessage,
  transferControlMessageSchema,
} from "@jianying/contracts";
import type { DataChannel } from "node-datachannel";
import nodeDataChannel from "node-datachannel";
import { afterEach, describe, expect, test } from "vitest";

import { createMaterialLibrary } from "../uploads/material-library.js";
import {
  createWebRtcUploadSession,
  toNodeDataChannelIceServers,
} from "./webrtc-upload-session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

describe("node-datachannel upload session", () => {
  test("converts short-lived browser TURN credentials into node-datachannel relay settings", () => {
    // Given: the same Cloudflare credential supplied to the mobile browser.
    const iceServers = [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        credential: "short-lived-password",
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "short-lived-user",
      },
    ];

    // When: the local peer is configured.
    const converted = toNodeDataChannelIceServers(iceServers);

    // Then: node-datachannel receives its native authenticated TURN representation.
    expect(converted).toEqual([
      "stun:stun.cloudflare.com:3478",
      {
        hostname: "turn.cloudflare.com",
        password: "short-lived-password",
        port: 3478,
        relayType: "TurnUdp",
        username: "short-lived-user",
      },
      {
        hostname: "turn.cloudflare.com",
        password: "short-lived-password",
        port: 443,
        relayType: "TurnTls",
        username: "short-lived-user",
      },
    ]);
  });

  test("delivers a binary material chunk through a real local WebRTC DataChannel", async () => {
    // Given: a local server upload session and a separate WebRTC mobile-peer simulation.
    const directory = await mkdtemp(join(tmpdir(), "jianying-webrtc-e2e-"));
    temporaryDirectories.push(directory);
    const materialLibrary = await createMaterialLibrary({
      availableBytes: async () => 1_000_000_000_000_000n,
      databasePath: join(directory, "state.sqlite"),
      materialRootPath: join(directory, "materials"),
    });
    const target = materialLibrary.createProjectTarget({
      categoryName: "raw-video",
      projectName: "pet-vlog",
    });
    const upload = await materialLibrary.createUpload({
      expectedSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expectedSizeBytes: 5n,
      fileName: "pet.mov",
      target,
    });
    const client = new nodeDataChannel.PeerConnection("mobile-test", {
      iceServers: [],
    });
    const diagnostics: string[] = [];
    const session = createWebRtcUploadSession({
      authorize: () => ({ kind: "accepted" }),
      iceServers: [],
      materialLibrary,
      maxChunkBytes: 1_024,
      onError: (error) => {
        diagnostics.push(`server-error:${error.name}:${error.message}`);
      },
      onSignal: (signal) => {
        diagnostics.push(`server-signal:${signal.kind}`);
        switch (signal.kind) {
          case "candidate":
            client.addRemoteCandidate(signal.candidate, signal.mid);
            return;
          case "description":
            client.setRemoteDescription(signal.sdp, signal.descriptionType);
            return;
          case "state":
            return;
          default:
            assertNever(signal);
        }
      },
      uploadId: upload.uploadId,
    });
    try {
      client.onLocalDescription((sdp, descriptionType) => {
        diagnostics.push(`client-description:${descriptionType}`);
        session.acceptRemoteDescription({ descriptionType, sdp });
      });
      client.onLocalCandidate((candidate, mid) => {
        diagnostics.push("client-candidate");
        session.acceptRemoteCandidate({ candidate, mid });
      });
      client.onStateChange((state) => {
        diagnostics.push(`client-state:${state}`);
      });
      const control = client.createDataChannel(
        `transfer-control/${upload.uploadId}`,
      );
      const data = client.createDataChannel(`transfer-data/${upload.uploadId}`);

      // When: the channels open, then the client streams the chunk and completion command.
      let authorizationAcknowledged = false;
      let dataSent = false;
      const sendDataWhenChannelsOpen = () => {
        if (
          dataSent ||
          !authorizationAcknowledged ||
          !control.isOpen() ||
          !data.isOpen()
        ) {
          return;
        }
        dataSent = true;
        data.sendMessageBinary(
          encodeDataChunkPacket({
            checksumSha256:
              "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            chunkIndex: 0n,
            offsetBytes: 0n,
            payload: new TextEncoder().encode("hello"),
          }),
        );
      };
      control.onOpen(() => {
        control.sendMessage(
          JSON.stringify({
            deviceId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
            deviceProof: "test-device-proof",
            dtlsFingerprint: localDtlsFingerprint(client),
            grant: "test-grant",
            type: "authorize",
            uploadId: upload.uploadId,
          }),
        );
      });
      data.onOpen(sendDataWhenChannelsOpen);
      const ready = waitForReady(control, upload.uploadId, diagnostics, () => {
        authorizationAcknowledged = true;
        sendDataWhenChannelsOpen();
      });
      client.setLocalDescription();

      // Then: the remote mobile peer sees final readiness only after the durable server commit.
      await expect(ready).resolves.toMatchObject({
        type: "ready",
        uploadId: upload.uploadId,
      });
      expect(materialLibrary.getUpload(upload.uploadId).state).toBe("ready");
    } finally {
      session.close();
      client.close();
      materialLibrary.close();
    }
  }, 10_000);
});

async function waitForReady(
  channel: DataChannel,
  uploadId: string,
  diagnostics: readonly string[],
  onAuthorizationAcknowledged: () => void,
): Promise<TransferControlMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new WebRtcE2eTimeoutError(diagnostics.join(",")));
    }, 5_000);
    channel.onMessage((message) => {
      if (typeof message !== "string") {
        return;
      }
      const control = transferControlMessageSchema.parse(JSON.parse(message));
      switch (control.type) {
        case "ack":
          if (control.ackEpoch === "0" && control.receivedBytes === "0") {
            onAuthorizationAcknowledged();
            return;
          }
          channel.sendMessage(JSON.stringify({ type: "complete", uploadId }));
          return;
        case "ready":
          clearTimeout(timeout);
          resolve(control);
          return;
        case "nack":
          clearTimeout(timeout);
          reject(new WebRtcControlNackError(control.code));
          return;
        case "authorize":
        case "cancel":
        case "complete":
        case "pause":
        case "resume":
          return;
        default:
          assertNever(control);
      }
    });
  });
}

class WebRtcControlNackError extends Error {
  readonly name = "WebRtcControlNackError";

  constructor(readonly code: string) {
    super(`The local WebRTC upload was rejected: ${code}`);
  }
}

class WebRtcE2eTimeoutError extends Error {
  readonly name = "WebRtcE2eTimeoutError";

  constructor(readonly diagnostics: string) {
    super(
      `The local WebRTC upload did not become ready within five seconds: ${diagnostics}`,
    );
  }
}

function assertNever(_value: never): never {
  throw new WebRtcE2eTimeoutError("");
}

function localDtlsFingerprint(peer: {
  readonly localDescription: () => { readonly sdp: string } | null;
}): string {
  const sdp = peer.localDescription()?.sdp;
  if (sdp === undefined) {
    throw new WebRtcE2eTimeoutError("The client has no local SDP");
  }
  const match = /^a=fingerprint:sha-256 (.+)$/m.exec(sdp);
  const fingerprint = match?.[1];
  if (fingerprint === undefined) {
    throw new WebRtcE2eTimeoutError(
      "The client SDP has no SHA-256 fingerprint",
    );
  }
  return fingerprint;
}
