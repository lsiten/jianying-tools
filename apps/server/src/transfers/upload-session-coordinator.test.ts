import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deviceIdSchema,
  type TransferControlMessage,
  type UploadId,
} from "@jianying/contracts";
import { afterEach, describe, expect, test } from "vitest";

import {
  createMaterialLibrary,
  type MaterialLibrary,
} from "../uploads/material-library.js";
import {
  createUploadSessionCoordinator,
  type WebRtcUploadSessionFactoryInput,
} from "./upload-session-coordinator.js";
import type {
  WebRtcUploadSession,
  WebRtcUploadSignal,
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

describe("upload session coordinator", () => {
  test("aborts a session locally when signaling setup cannot be completed", async () => {
    // Given: a newly allocated local peer before its Mac signaling socket is connected.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const outboundMessages: unknown[] = [];
    const fakeSessions: FakeWebRtcUploadSession[] = [];
    const coordinator = createUploadSessionCoordinator({
      createWebRtcSession: (input) => {
        const session = new FakeWebRtcUploadSession(input);
        fakeSessions.push(session);
        return session;
      },
      iceServers: [],
      materialLibrary: library,
      maxChunkBytes: 1_024,
      nowEpochMs: () => 1_000,
      onOutboundSignal: (message) => outboundMessages.push(message),
      signalingSecret: "test-signaling-secret",
      tokenLifetimeMs: 60_000,
    });
    const created = coordinator.create({
      deviceId: testDeviceId(),
      uploadId: upload.uploadId,
    });
    const session = fakeSessions[0];

    if (session === undefined) {
      throw new Error("The fake WebRTC session was not created");
    }

    // When: WSS startup fails before the session can receive a remote offer.
    coordinator.abort(created.sessionId);

    // Then: local resources are released without attempting an impossible outbound close.
    expect(session.closed).toBe(true);
    expect(outboundMessages).toEqual([]);
    expect(
      coordinator.accept({
        candidate: "candidate:after-abort",
        mid: "0",
        sessionId: created.sessionId,
        type: "candidate",
      }),
    ).toEqual({ kind: "rejected", reason: "SESSION_UNKNOWN" });
  });

  test("binds a one-time transfer grant and both short-lived signaling roles to one upload session", async () => {
    // Given: a durable local upload and a coordinator whose clock is under test control.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const outboundMessages: unknown[] = [];
    const fakeSessions: FakeWebRtcUploadSession[] = [];
    const coordinator = createUploadSessionCoordinator({
      createWebRtcSession: (input) => {
        const session = new FakeWebRtcUploadSession(input);
        fakeSessions.push(session);
        return session;
      },
      iceServers: [],
      materialLibrary: library,
      maxChunkBytes: 1_024,
      nowEpochMs: () => 1_000,
      onOutboundSignal: (message) => outboundMessages.push(message),
      signalingSecret: "test-signaling-secret",
      tokenLifetimeMs: 60_000,
    });

    // When: the paired-device layer asks the server to create one upload session.
    const created = coordinator.create({
      deviceId: testDeviceId(),
      uploadId: upload.uploadId,
    });
    const session = fakeSessions[0];

    // Then: credentials, grant, signal routing, and shutdown stay bound to that exact session.
    expect(session).toBeDefined();
    if (session === undefined) {
      throw new Error("The fake WebRTC session was not created");
    }
    expect(created.expiresAtEpochMs).toBe(61_000);
    expect(created.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(
      await session.input.authorize(
        authorizationMessage(created.transferGrant, upload.uploadId),
      ),
    ).toEqual({
      kind: "rejected",
      reason: "DEVICE_PROOF_INVALID",
    });
    expect(
      await session.input.authorize(
        authorizationMessage("wrong-grant", upload.uploadId),
      ),
    ).toEqual({ kind: "rejected", reason: "AUTHORIZE_REJECTED" });

    session.emit({
      candidate: "candidate:1",
      kind: "candidate",
      mid: "0",
    });
    expect(outboundMessages).toEqual([
      {
        candidate: "candidate:1",
        mid: "0",
        sessionId: created.sessionId,
        type: "candidate",
      },
    ]);

    const accepted = coordinator.accept({
      candidate: "candidate:2",
      mid: "0",
      sessionId: created.sessionId,
      type: "candidate",
    });
    expect(accepted).toEqual({ kind: "accepted" });
    expect(session.remoteCandidates).toEqual([
      { candidate: "candidate:2", mid: "0" },
    ]);

    coordinator.close(created.sessionId, "TRANSFER_FINISHED");
    expect(session.closed).toBe(true);
    expect(outboundMessages).toContainEqual({
      reason: "TRANSFER_FINISHED",
      sessionId: created.sessionId,
      type: "close",
    });
  });

  test("refuses to issue another session after the upload was cancelled", async () => {
    // Given: a cancelled durable upload whose previous mobile attempt was abandoned.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    await library.cancelUpload(upload.uploadId);
    const coordinator = createUploadSessionCoordinator({
      createWebRtcSession: () => {
        throw new Error(
          "A cancelled upload must not construct a peer connection",
        );
      },
      iceServers: [],
      materialLibrary: library,
      maxChunkBytes: 1_024,
      nowEpochMs: () => 1_000,
      onOutboundSignal: () => undefined,
      signalingSecret: "test-signaling-secret",
      tokenLifetimeMs: 60_000,
    });

    // When: stale client state tries to resume by requesting a fresh session.
    let thrown: unknown;
    try {
      coordinator.create({
        deviceId: testDeviceId(),
        uploadId: upload.uploadId,
      });
    } catch (error) {
      thrown = error;
    }

    // Then: no credential or DataChannel receiver is recreated for the terminal upload.
    expect(thrown).toMatchObject({
      name: "UploadSessionCoordinatorError",
      reason: "UPLOAD_NOT_TRANSFERABLE",
    });
  });

  test("refuses an unpaired device before allocating a peer or signaling credentials", async () => {
    // Given: a durable upload and a device identifier that has never completed local pairing.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const coordinator = createUploadSessionCoordinator({
      createWebRtcSession: () => {
        throw new Error("An unpaired device must not allocate a WebRTC peer");
      },
      iceServers: [],
      materialLibrary: library,
      maxChunkBytes: 1_024,
      nowEpochMs: () => 1_000,
      onOutboundSignal: () => undefined,
      signalingSecret: "test-signaling-secret",
      tokenLifetimeMs: 60_000,
    });

    // When: an unknown phone asks to receive transfer credentials.
    const create = () =>
      coordinator.create({
        deviceId: deviceIdSchema.parse("0b3e08f4-9e6a-4bf6-b65b-9745d8f442f5"),
        uploadId: upload.uploadId,
      });

    // Then: no grant or signaling token can be minted for that device.
    expect(create).toThrow(
      expect.objectContaining({ reason: "DEVICE_NOT_PAIRED" }),
    );
  });

  test("closes a session with CONNECTION_FAILED when WebRTC reports a failed connection", async () => {
    // Given: an active upload session.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const outboundMessages: unknown[] = [];
    const fakeSessions: FakeWebRtcUploadSession[] = [];
    const coordinator = createUploadSessionCoordinator({
      createWebRtcSession: (input) => {
        const session = new FakeWebRtcUploadSession(input);
        fakeSessions.push(session);
        return session;
      },
      iceServers: [],
      materialLibrary: library,
      maxChunkBytes: 1_024,
      nowEpochMs: () => 1_000,
      onOutboundSignal: (message) => outboundMessages.push(message),
      signalingSecret: "test-signaling-secret",
      tokenLifetimeMs: 60_000,
    });
    const created = coordinator.create({
      deviceId: testDeviceId(),
      uploadId: upload.uploadId,
    });
    const session = fakeSessions[0];

    if (session === undefined) {
      throw new Error("The fake WebRTC session was not created");
    }

    // When: ICE reports that it cannot establish a path.
    session.emit({ kind: "state", state: "failed" });

    // Then: the failed session is closed with a normal recoverable connection failure.
    expect(session.closed).toBe(true);
    expect(outboundMessages).toEqual([
      {
        reason: "CONNECTION_FAILED",
        sessionId: created.sessionId,
        type: "close",
      },
    ]);
    expect(
      coordinator.accept({
        candidate: "candidate:after-failure",
        mid: "0",
        sessionId: created.sessionId,
        type: "candidate",
      }),
    ).toEqual({ kind: "rejected", reason: "SESSION_UNKNOWN" });
  });

  test("releases the WebRTC session when signaling delivery fails during close", async () => {
    // Given: an active transfer whose Cloudflare socket has already failed.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const fakeSessions: FakeWebRtcUploadSession[] = [];
    const reportedErrors: Error[] = [];
    const coordinator = createUploadSessionCoordinator({
      createWebRtcSession: (input) => {
        const session = new FakeWebRtcUploadSession(input);
        fakeSessions.push(session);
        return session;
      },
      iceServers: [],
      materialLibrary: library,
      maxChunkBytes: 1_024,
      nowEpochMs: () => 1_000,
      onError: (error) => reportedErrors.push(error),
      onOutboundSignal: () => {
        throw new SignalingDeliveryError();
      },
      signalingSecret: "test-signaling-secret",
      tokenLifetimeMs: 60_000,
    });
    const created = coordinator.create({
      deviceId: testDeviceId(),
      uploadId: upload.uploadId,
    });
    const session = fakeSessions[0];

    if (session === undefined) {
      throw new Error("The fake WebRTC session was not created");
    }

    // When: the direct session must be closed after a terminal local decision.
    coordinator.close(created.sessionId, "TRANSFER_CANCELLED");

    // Then: socket delivery failure is observable but cannot leave a live local peer behind.
    expect(session.closed).toBe(true);
    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0]).toBeInstanceOf(SignalingDeliveryError);
    expect(
      coordinator.accept({
        candidate: "candidate:after-close",
        mid: "0",
        sessionId: created.sessionId,
        type: "candidate",
      }),
    ).toEqual({ kind: "rejected", reason: "SESSION_UNKNOWN" });
  });
});

class SignalingDeliveryError extends Error {
  readonly name = "SignalingDeliveryError";
}

class FakeWebRtcUploadSession implements WebRtcUploadSession {
  closed = false;
  readonly remoteCandidates: {
    readonly candidate: string;
    readonly mid: string;
  }[] = [];
  readonly remoteDescriptions: {
    readonly descriptionType: "answer" | "offer";
    readonly sdp: string;
  }[] = [];

  constructor(readonly input: WebRtcUploadSessionFactoryInput) {}

  acceptRemoteCandidate(input: {
    readonly candidate: string;
    readonly mid: string;
  }): void {
    this.remoteCandidates.push(input);
  }

  acceptRemoteDescription(input: {
    readonly descriptionType: "answer" | "offer";
    readonly sdp: string;
  }): void {
    this.remoteDescriptions.push(input);
  }

  close(): void {
    this.closed = true;
  }

  emit(signal: WebRtcUploadSignal): void {
    this.input.onSignal(signal);
  }
}

function authorizationMessage(
  grant: string,
  uploadId: UploadId,
): Extract<TransferControlMessage, { readonly type: "authorize" }> {
  return {
    deviceId: testDeviceId(),
    deviceProof: "test-device-proof",
    dtlsFingerprint: "test-dtls-fingerprint",
    grant,
    type: "authorize",
    uploadId,
  };
}

async function createTestLibrary(): Promise<MaterialLibrary> {
  const directory = await mkdtemp(join(tmpdir(), "jianying-upload-session-"));
  temporaryDirectories.push(directory);
  const library = await createMaterialLibrary({
    availableBytes: async () => 1_000_000_000_000_000n,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
  });
  const keyPair = generateKeyPairSync("ed25519");
  library.registerPairedDevice({
    deviceId: testDeviceId(),
    displayName: "test iPhone",
    publicKeySpkiBase64Url: keyPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
  });
  return library;
}

function testDeviceId() {
  return deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d");
}

async function createUpload(
  library: MaterialLibrary,
): Promise<{ readonly uploadId: UploadId }> {
  const target = library.createProjectTarget({
    categoryName: "raw-video",
    projectName: "pet-vlog",
  });
  return library.createUpload({
    expectedSha256:
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    expectedSizeBytes: 5n,
    fileName: "pet.mov",
    target,
  });
}
