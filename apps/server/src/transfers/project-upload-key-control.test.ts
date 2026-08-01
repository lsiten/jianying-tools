import {
  categoryIdSchema,
  deviceIdSchema,
  projectIdSchema,
  projectUploadKeyIdSchema,
  REMOTE_CONTROL_MESSAGE_TYPES,
  type RemoteControlMacResponse,
  uploadIdSchema,
  webRtcSessionIdSchema,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import { createProjectUploadKeyControl } from "./project-upload-key-control.js";

const directIceServers = [{ urls: ["stun:stun.example.net:3478"] }];
const turnIceServers = [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  {
    credential: "short-lived-password",
    urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
    username: "short-lived-user",
  },
];

describe("project upload Key remote control", () => {
  test("returns the Mac-bound directory name after a mobile Key redemption request", () => {
    // Given: an online Mac material library and a mobile H5 redemption frame.
    const sent: RemoteControlMacResponse[] = [];
    const control = createProjectUploadKeyControl({
      materialLibrary: {
        cancelUpload: async () => undefined,
        createProjectUpload: async () => {
          throw new Error("Unexpected upload creation");
        },
        redeemProjectUploadKey: () => ({
          deviceId: deviceIdSchema.parse(
            "2ee77da2-3d07-4d91-b290-f2c560ae046d",
          ),
          directoryName: "傍晚散步",
          keyId: projectUploadKeyIdSchema.parse(
            "5ee77da2-3d07-4d91-b290-f2c560ae046d",
          ),
          target: {
            categoryId: categoryIdSchema.parse(
              "4ee77da2-3d07-4d91-b290-f2c560ae046d",
            ),
            projectId: projectIdSchema.parse(
              "3ee77da2-3d07-4d91-b290-f2c560ae046d",
            ),
          },
        }),
        resumeProjectUpload: () => {
          throw new Error("Unexpected upload resume");
        },
      },
      send: (response) => sent.push(response),
      transferService: {
        create: async () => {
          throw new Error("Unexpected transfer creation");
        },
      },
    });

    // When: the H5 presents a fresh Key and its device public identity through the Worker.
    control.receive({
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      displayName: "iPhone Safari",
      publicKeySpkiBase64Url: "test_public_key",
      rawKey:
        "jyup1.test_upload_node_id_01.5ee77da2-3d07-4d91-b290-f2c560ae046d.test_secret",
      requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REQUEST,
    });

    // Then: the browser is told the exact directory assigned to that Key, not a caller-selected path.
    expect(sent).toEqual([
      {
        directoryName: "傍晚散步",
        keyId: projectUploadKeyIdSchema.parse(
          "5ee77da2-3d07-4d91-b290-f2c560ae046d",
        ),
        requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
        target: {
          categoryId: categoryIdSchema.parse(
            "4ee77da2-3d07-4d91-b290-f2c560ae046d",
          ),
          projectId: projectIdSchema.parse(
            "3ee77da2-3d07-4d91-b290-f2c560ae046d",
          ),
        },
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_ACCEPTED,
      },
    ]);
  });

  test("creates a transfer only from the stored Key binding and returns a mobile signaling capability", async () => {
    // Given: the Mac can resolve a paired Key, reserve material storage, and open an authenticated transfer session.
    const sent: RemoteControlMacResponse[] = [];
    const control = createProjectUploadKeyControl({
      materialLibrary: {
        cancelUpload: async () => undefined,
        createProjectUpload: async (input) => {
          expect(input.keyId).toBe(
            projectUploadKeyIdSchema.parse(
              "5ee77da2-3d07-4d91-b290-f2c560ae046d",
            ),
          );
          expect(input.deviceId).toBe(
            deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
          );
          return {
            uploadId: uploadIdSchema.parse(
              "6ee77da2-3d07-4d91-b290-f2c560ae046d",
            ),
          };
        },
        redeemProjectUploadKey: () => {
          throw new Error("Unexpected Key redemption");
        },
        resumeProjectUpload: () => {
          throw new Error("Unexpected upload resume");
        },
      },
      send: (response) => sent.push(response),
      transferService: {
        create: async (input) => {
          expect(input.deviceId).toBe(
            deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
          );
          return {
            expiresAtEpochMs: 123_000,
            iceServers: turnIceServers,
            macSignalingToken: "mac-token",
            mobileSignalingToken: "mobile-token",
            sessionId: webRtcSessionIdSchema.parse(
              "7ee77da2-3d07-4d91-b290-f2c560ae046d",
            ),
            transferGrant: "transfer-grant",
          };
        },
      },
    });

    // When: the paired H5 requests a file session without providing a material directory.
    await control.receive({
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      expectedSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedSizeBytes: "1048576",
      fileName: "walk.mp4",
      keyId: projectUploadKeyIdSchema.parse(
        "5ee77da2-3d07-4d91-b290-f2c560ae046d",
      ),
      requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REQUEST,
    });

    // Then: only the short-lived mobile capability and direct STUN configuration reach the H5.
    expect(sent).toEqual([
      {
        expiresAtEpochMs: 123_000,
        iceServers: turnIceServers,
        maxChunkBytes: 1_048_576,
        mobileSignalingToken: "mobile-token",
        requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
        sessionId: webRtcSessionIdSchema.parse(
          "7ee77da2-3d07-4d91-b290-f2c560ae046d",
        ),
        transferGrant: "transfer-grant",
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED,
        uploadId: uploadIdSchema.parse("6ee77da2-3d07-4d91-b290-f2c560ae046d"),
      },
    ]);
  });

  test("issues a new short-lived session only after a bound upload passes resume verification", async () => {
    // Given: a reconnecting H5 asks to resume an upload ID it already owns.
    const sent: RemoteControlMacResponse[] = [];
    const uploadId = uploadIdSchema.parse(
      "6ee77da2-3d07-4d91-b290-f2c560ae046d",
    );
    const control = createProjectUploadKeyControl({
      materialLibrary: {
        cancelUpload: async () => undefined,
        createProjectUpload: async () => {
          throw new Error("Unexpected upload creation");
        },
        redeemProjectUploadKey: () => {
          throw new Error("Unexpected Key redemption");
        },
        resumeProjectUpload: (input) => {
          expect(input.uploadId).toBe(uploadId);
          return {
            ackEpoch: 3n,
            receivedBytes: 1_048_576n,
            state: "transferring",
            uploadId,
          };
        },
      },
      send: (response) => sent.push(response),
      transferService: {
        create: async () => ({
          expiresAtEpochMs: 123_000,
          iceServers: directIceServers,
          macSignalingToken: "mac-token",
          mobileSignalingToken: "mobile-token",
          sessionId: webRtcSessionIdSchema.parse(
            "7ee77da2-3d07-4d91-b290-f2c560ae046d",
          ),
          transferGrant: "transfer-grant",
        }),
      },
    });

    // When: the paired device requests a fresh WebRTC route for that durable upload.
    await control.receive({
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      expectedSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedSizeBytes: "1048576",
      fileName: "walk.mp4",
      keyId: projectUploadKeyIdSchema.parse(
        "5ee77da2-3d07-4d91-b290-f2c560ae046d",
      ),
      requestId: "1ee77da2-3d07-4d91-b290-f2c560ae046d",
      type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST,
      uploadId,
    });

    // Then: it receives a new session capability but the same durable upload ID.
    expect(sent).toEqual([
      expect.objectContaining({
        type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED,
        uploadId,
      }),
    ]);
  });
});
