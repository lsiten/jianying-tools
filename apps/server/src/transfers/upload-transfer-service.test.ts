import {
  deviceIdSchema,
  type SignalingCloseReason,
  type SignalingMessage,
  uploadIdSchema,
  webRtcSessionIdSchema,
} from "@jianying/contracts";
import { describe, expect, test } from "vitest";
import type { SessionSignalingGateway } from "./session-signaling-gateway.js";
import type {
  CreatedUploadSession,
  SignalingAcceptance,
  UploadSessionCoordinator,
} from "./upload-session-coordinator.js";
import { createUploadTransferService } from "./upload-transfer-service.js";

describe("upload transfer service", () => {
  test("connects the Mac signal socket before returning a mobile session grant", async () => {
    // Given: an allocated local peer and a session gateway that records its Mac connection request.
    const coordinator = new FakeUploadSessionCoordinator();
    const gateway = new FakeSessionSignalingGateway();
    const iceServers = [
      {
        credential: "short-lived-password",
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "short-lived-user",
      },
    ];
    const service = createUploadTransferService({
      coordinator,
      gateway,
      onError: () => undefined,
      resolveIceServers: async () => iceServers,
    });

    // When: a paired-device layer requests a transfer session.
    const created = await service.create({
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      uploadId: uploadIdSchema.parse("3ccf1c18-f4c3-4a0d-af42-311eeef3b3a9"),
    });

    // Then: the mobile never receives usable credentials before the Mac WSS route exists.
    expect(created).toMatchObject({
      ...coordinator.created,
      iceServers,
    });
    expect(gateway.macSignalingToken).toBe(
      coordinator.created.macSignalingToken,
    );
    expect(gateway.sessionId).toBe(coordinator.created.sessionId);
    expect(coordinator.createInput?.iceServers).toEqual(iceServers);
    expect(created.iceServers).toEqual(iceServers);
  });

  test("aborts the local peer if the Mac signaling socket cannot open", async () => {
    // Given: a Worker connection failure before the mobile gets session credentials.
    const coordinator = new FakeUploadSessionCoordinator();
    const gateway = new FakeSessionSignalingGateway();
    gateway.connectError = new SignalOpenError();
    const reportedErrors: Error[] = [];
    const service = createUploadTransferService({
      coordinator,
      gateway,
      onError: (error) => reportedErrors.push(error),
      resolveIceServers: async () => [],
    });

    // When: the local service attempts to create the transfer route.
    const create = service.create({
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      uploadId: uploadIdSchema.parse("3ccf1c18-f4c3-4a0d-af42-311eeef3b3a9"),
    });

    // Then: no half-open peer or token remains after the route failure.
    await expect(create).rejects.toBeInstanceOf(SignalOpenError);
    expect(coordinator.aborted).toEqual([coordinator.created.sessionId]);
    expect(reportedErrors).toEqual([gateway.connectError]);
  });

  test("replaces an abandoned session before resuming the same upload", async () => {
    // Given: one durable upload whose first relay session stopped without a clean mobile close frame.
    const coordinator = new FakeUploadSessionCoordinator();
    const gateway = new FakeSessionSignalingGateway();
    const service = createUploadTransferService({
      coordinator,
      gateway,
      onError: () => undefined,
      resolveIceServers: async () => [],
    });
    const input = {
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      uploadId: uploadIdSchema.parse("3ccf1c18-f4c3-4a0d-af42-311eeef3b3a9"),
    };
    const first = await service.create(input);

    // When: the browser asks for a fresh resume session for that same upload.
    const second = await service.create(input);

    // Then: the prior local peer and Mac signaling socket are both closed before the new grant is used.
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(coordinator.closed).toEqual([
      { reason: "CONNECTION_FAILED", sessionId: first.sessionId },
    ]);
    expect(gateway.closed).toEqual([first.sessionId]);
  });
});

class SignalOpenError extends Error {
  readonly name = "SignalOpenError";
}

class FakeUploadSessionCoordinator implements UploadSessionCoordinator {
  readonly aborted: string[] = [];
  readonly closed: {
    readonly reason: SignalingCloseReason;
    readonly sessionId: string;
  }[] = [];
  createInput: Parameters<UploadSessionCoordinator["create"]>[0] | undefined;
  readonly created: CreatedUploadSession = {
    expiresAtEpochMs: 61_000,
    iceServers: [],
    macSignalingToken: "mac-token",
    mobileSignalingToken: "mobile-token",
    sessionId: webRtcSessionIdSchema.parse(
      "cc6429b6-0e8b-4b6e-9c5a-0c8eca442703",
    ),
    transferGrant: "transfer-grant",
  };
  private createCount = 0;

  accept(_message: SignalingMessage): SignalingAcceptance {
    return { kind: "accepted" };
  }

  abort(sessionId: ReturnType<typeof webRtcSessionIdSchema.parse>): void {
    this.aborted.push(sessionId);
  }

  close(
    sessionId: ReturnType<typeof webRtcSessionIdSchema.parse>,
    reason: SignalingCloseReason,
  ): void {
    this.closed.push({ reason, sessionId });
  }

  closeExpired(): number {
    return 0;
  }

  create(
    input: Parameters<UploadSessionCoordinator["create"]>[0],
  ): CreatedUploadSession {
    this.createInput = input;
    if (this.createCount === 0) {
      this.createCount += 1;
      return { ...this.created, iceServers: input.iceServers ?? [] };
    }
    this.createCount += 1;
    return {
      ...this.created,
      iceServers: input.iceServers ?? [],
      sessionId: webRtcSessionIdSchema.parse(
        `cc6429b${this.createCount}-0e8b-4b6e-9c5a-0c8eca442703`,
      ),
    };
  }
}

class FakeSessionSignalingGateway implements SessionSignalingGateway {
  readonly closed: string[] = [];
  connectError: Error | undefined;
  macSignalingToken: string | undefined;
  sessionId: string | undefined;

  close(sessionId: ReturnType<typeof webRtcSessionIdSchema.parse>): void {
    this.closed.push(sessionId);
  }

  async connectMacSession(input: {
    readonly macSignalingToken: string;
    readonly onMessage: (message: SignalingMessage) => void;
    readonly onSessionError: (error: Error) => void;
    readonly sessionId: ReturnType<typeof webRtcSessionIdSchema.parse>;
  }): Promise<void> {
    this.macSignalingToken = input.macSignalingToken;
    this.sessionId = input.sessionId;
    if (this.connectError !== undefined) {
      throw this.connectError;
    }
  }

  forwardOutbound(_message: SignalingMessage): void {}
}
