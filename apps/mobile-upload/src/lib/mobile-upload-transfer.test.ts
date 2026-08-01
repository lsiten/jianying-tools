import {
  deviceIdSchema,
  projectUploadKeyIdSchema,
  REMOTE_CONTROL_MESSAGE_TYPES,
  remoteControlMacResponseSchema,
  uploadIdSchema,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import type { MobileIdentity, ResumableMobileUpload } from "./mobile-state.js";
import {
  executeMobileUploadTransferWithDependencies,
  type MobileUploadTransferDependencies,
  type RetryableMobileUpload,
} from "./mobile-upload-transfer.js";
import { WebRtcFileTransferError } from "./webrtc-file-transfer.js";

describe("mobile upload transfer", () => {
  test("resumes the hash-matched file when same-name candidates exist", async () => {
    // Given: two interrupted uploads sharing a file name and byte size.
    const expectedSha256 = "a".repeat(64);
    const matching = resumableUpload({
      expectedSha256,
      uploadId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
    });
    const attempt: RetryableMobileUpload = {
      destination: matching,
      file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
      identity: await identity(),
      resumableCandidates: [
        resumableUpload({
          expectedSha256: "b".repeat(64),
          uploadId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
        }),
        matching,
      ],
    };
    const requests: unknown[] = [];
    const acceptedResumableUploads: ResumableMobileUpload[] = [];
    const dependencies = fakeDependencies(expectedSha256, requests);

    // When: the picker supplies the original matching file after a reload.
    await executeMobileUploadTransferWithDependencies(
      {
        attempt,
        onResumableUpload: async (upload) => {
          acceptedResumableUploads.push(upload);
        },
        onUpdate: () => undefined,
      },
      dependencies,
    );

    // Then: only the matching durable upload receives a new resume session.
    expect(requests).toContainEqual(
      expect.objectContaining({
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST,
        uploadId: matching.uploadId,
      }),
    );
    expect(acceptedResumableUploads).toEqual([matching]);
  });

  test("refreshes a failed relay session through the same durable upload", async () => {
    // Given: a new file whose first relay credential has expired before ICE connects.
    const expectedSha256 = "c".repeat(64);
    const attempt: RetryableMobileUpload = {
      destination: resumableUpload({
        expectedSha256,
        uploadId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      }),
      file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
      identity: await identity(),
    };
    const requests: unknown[] = [];
    const credentials: string[] = [];
    let transferAttempts = 0;
    const dependencies: MobileUploadTransferDependencies = {
      ...fakeDependencies(expectedSha256, requests),
      requestMacControl: async (input) => {
        requests.push(input.request);
        const isResume =
          input.request.type ===
          REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST;
        return remoteControlMacResponseSchema.parse({
          expiresAtEpochMs: 1_000,
          iceServers: [
            {
              credential: isResume ? "fresh-credential" : "expired-credential",
              urls: ["turn:relay.example.test:3478?transport=udp"],
              username: isResume ? "fresh-user" : "expired-user",
            },
          ],
          maxChunkBytes: 1_024,
          mobileSignalingToken: isResume ? "fresh-token" : "expired-token",
          requestId: input.request.requestId,
          sessionId: isResume
            ? "7ee77da2-3d07-4d91-b290-f2c560ae046d"
            : "4ee77da2-3d07-4d91-b290-f2c560ae046d",
          transferGrant: isResume ? "fresh-grant" : "expired-grant",
          type: isResume
            ? REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED
            : REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED,
          uploadId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
        });
      },
      transferFileOverWebRtc: async (input) => {
        credentials.push(
          input.iceServers
            .map((server) => server.credential)
            .filter(
              (credential): credential is string => credential !== undefined,
            )
            .join(","),
        );
        transferAttempts += 1;
        if (transferAttempts === 1) {
          throw new WebRtcFileTransferError("CONNECTION_FAILED");
        }
      },
    };

    // When: the first direct transfer reports an ICE connection failure.
    await executeMobileUploadTransferWithDependencies(
      {
        attempt,
        onResumableUpload: async () => undefined,
        onUpdate: () => undefined,
      },
      dependencies,
    );

    // Then: the browser requests a new resume session and uses only its fresh relay credential.
    expect(requests).toMatchObject([
      {
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REQUEST,
      },
      {
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST,
        uploadId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      },
    ]);
    expect(credentials).toEqual(["expired-credential", "fresh-credential"]);
  });
});

function fakeDependencies(
  expectedSha256: string,
  requests: unknown[],
): MobileUploadTransferDependencies {
  return {
    hashFileSha256: async () => expectedSha256,
    randomRequestId: () => "3ee77da2-3d07-4d91-b290-f2c560ae046d",
    requestMacControl: async (input) => {
      requests.push(input.request);
      return remoteControlMacResponseSchema.parse({
        expiresAtEpochMs: 1_000,
        iceServers: [{ urls: ["stun:stun.example.test:3478"] }],
        maxChunkBytes: 1_024,
        mobileSignalingToken: "mobile-token",
        requestId: "3ee77da2-3d07-4d91-b290-f2c560ae046d",
        sessionId: "4ee77da2-3d07-4d91-b290-f2c560ae046d",
        transferGrant: "transfer-grant",
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED,
        uploadId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      });
    },
    transferFileOverWebRtc: async () => undefined,
    workerBaseUrl: () => "https://signal.example.test",
  };
}

async function identity(): Promise<MobileIdentity> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  if (
    !(keyPair.privateKey instanceof CryptoKey) ||
    !(keyPair.publicKey instanceof CryptoKey)
  ) {
    throw new Error("Expected an Ed25519 key pair");
  }
  return {
    deviceId: deviceIdSchema.parse("5ee77da2-3d07-4d91-b290-f2c560ae046d"),
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
}

function resumableUpload(input: {
  readonly expectedSha256: string;
  readonly uploadId: string;
}): ResumableMobileUpload {
  return {
    directoryName: "Pet Vlog",
    expectedSha256: input.expectedSha256,
    fileName: "clip.mp4",
    keyId: projectUploadKeyIdSchema.parse(
      "6ee77da2-3d07-4d91-b290-f2c560ae046d",
    ),
    nodeId: "abcdefghijklmnopqrstuv",
    sizeBytes: 5,
    uploadId: uploadIdSchema.parse(input.uploadId),
  };
}
