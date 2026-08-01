import type {
  DeviceId,
  IceServerDescriptor,
  SignalingCloseReason,
  SignalingMessage,
  UploadId,
  WebRtcSessionId,
} from "@jianying/contracts";
import type { SessionSignalingGateway } from "./session-signaling-gateway.js";
import type {
  CreatedUploadSession,
  UploadSessionCoordinator,
} from "./upload-session-coordinator.js";

export const UPLOAD_TRANSFER_SERVICE_ERROR_REASONS = {
  INBOUND_SIGNAL_REJECTED: "INBOUND_SIGNAL_REJECTED",
  SIGNALING_SETUP_FAILED: "SIGNALING_SETUP_FAILED",
} as const;

export type UploadTransferServiceErrorReason =
  (typeof UPLOAD_TRANSFER_SERVICE_ERROR_REASONS)[keyof typeof UPLOAD_TRANSFER_SERVICE_ERROR_REASONS];

export class UploadTransferServiceError extends Error {
  readonly name = "UploadTransferServiceError";

  constructor(readonly reason: UploadTransferServiceErrorReason) {
    super(`Upload transfer service failed: ${reason}`);
  }
}

export interface UploadTransferService {
  close(sessionId: WebRtcSessionId, reason: SignalingCloseReason): void;
  create(input: {
    readonly deviceId: DeviceId;
    readonly uploadId: UploadId;
  }): Promise<CreatedUploadSession>;
}

/** Composes local WebRTC state with its Mac-side Cloudflare signaling route. */
export function createUploadTransferService(input: {
  readonly coordinator: UploadSessionCoordinator;
  readonly gateway: SessionSignalingGateway;
  readonly onError: (error: Error) => void;
  readonly resolveIceServers: () => Promise<readonly IceServerDescriptor[]>;
}): UploadTransferService {
  return new DefaultUploadTransferService(input);
}

class DefaultUploadTransferService implements UploadTransferService {
  private readonly sessionByUpload = new Map<UploadId, WebRtcSessionId>();

  constructor(
    private readonly input: {
      readonly coordinator: UploadSessionCoordinator;
      readonly gateway: SessionSignalingGateway;
      readonly onError: (error: Error) => void;
      readonly resolveIceServers: () => Promise<readonly IceServerDescriptor[]>;
    },
  ) {}

  async create(input: {
    readonly deviceId: DeviceId;
    readonly uploadId: UploadId;
  }): Promise<CreatedUploadSession> {
    const iceServers = await this.input.resolveIceServers();
    const created = this.input.coordinator.create({ ...input, iceServers });
    const previousSessionId = this.sessionByUpload.get(input.uploadId);
    if (previousSessionId !== undefined) {
      this.close(previousSessionId, "CONNECTION_FAILED");
    }
    this.sessionByUpload.set(input.uploadId, created.sessionId);
    try {
      await this.input.gateway.connectMacSession({
        macSignalingToken: created.macSignalingToken,
        onMessage: (message) => this.acceptInbound(created.sessionId, message),
        onSessionError: (error) =>
          this.abortOnSignalingFailure(created.sessionId, error),
        sessionId: created.sessionId,
      });
      return created;
    } catch (error) {
      this.abortOnSignalingFailure(created.sessionId, error);
      throw error;
    }
  }

  close(sessionId: WebRtcSessionId, reason: SignalingCloseReason): void {
    this.input.coordinator.close(sessionId, reason);
    this.input.gateway.close(sessionId);
    this.forgetSession(sessionId);
  }

  private acceptInbound(
    expectedSessionId: WebRtcSessionId,
    message: SignalingMessage,
  ): void {
    const acceptance = this.input.coordinator.accept(message);
    if (acceptance.kind === "rejected") {
      this.input.onError(
        new UploadTransferServiceError("INBOUND_SIGNAL_REJECTED"),
      );
      this.input.gateway.close(expectedSessionId);
      return;
    }
    if (message.type === "close") {
      this.input.gateway.close(expectedSessionId);
    }
  }

  private abortOnSignalingFailure(
    sessionId: WebRtcSessionId,
    error: unknown,
  ): void {
    this.input.coordinator.abort(sessionId);
    this.input.gateway.close(sessionId);
    this.forgetSession(sessionId);
    if (error instanceof Error) {
      this.input.onError(error);
      return;
    }
    this.input.onError(
      new UploadTransferServiceError("SIGNALING_SETUP_FAILED"),
    );
  }

  private forgetSession(sessionId: WebRtcSessionId): void {
    for (const [uploadId, activeSessionId] of this.sessionByUpload) {
      if (activeSessionId === sessionId) {
        this.sessionByUpload.delete(uploadId);
        return;
      }
    }
  }
}
