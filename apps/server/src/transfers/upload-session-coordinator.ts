import { randomBytes, randomUUID } from "node:crypto";
import {
  type DeviceId,
  type IceServerDescriptor,
  type SignalingCloseReason,
  type SignalingMessage,
  type UploadId,
  type WebRtcSessionId,
  webRtcSessionIdSchema,
} from "@jianying/contracts";

import type { MaterialLibrary } from "../uploads/material-library.js";
import type { TransferAuthorization } from "./incoming-upload-receiver.js";
import { createPairedDeviceAuthorization } from "./paired-device-authorization.js";
import { createSignalingToken } from "./signaling-token.js";
import {
  createWebRtcUploadSession,
  type WebRtcUploadSession,
  type WebRtcUploadSignal,
} from "./webrtc-upload-session.js";

export const UPLOAD_SESSION_COORDINATOR_ERROR_REASONS = {
  INVALID_TOKEN_LIFETIME: "INVALID_TOKEN_LIFETIME",
  DEVICE_NOT_PAIRED: "DEVICE_NOT_PAIRED",
  OUTBOUND_SIGNAL_DELIVERY_FAILED: "OUTBOUND_SIGNAL_DELIVERY_FAILED",
  TOKEN_EXPIRY_OVERFLOW: "TOKEN_EXPIRY_OVERFLOW",
  UPLOAD_NOT_TRANSFERABLE: "UPLOAD_NOT_TRANSFERABLE",
  UNSUPPORTED_LOCAL_DESCRIPTION: "UNSUPPORTED_LOCAL_DESCRIPTION",
} as const;

export type UploadSessionCoordinatorErrorReason =
  (typeof UPLOAD_SESSION_COORDINATOR_ERROR_REASONS)[keyof typeof UPLOAD_SESSION_COORDINATOR_ERROR_REASONS];

export class UploadSessionCoordinatorError extends Error {
  readonly name = "UploadSessionCoordinatorError";

  constructor(readonly reason: UploadSessionCoordinatorErrorReason) {
    super(`Upload session coordinator failed: ${reason}`);
  }
}

export type WebRtcUploadSessionFactoryInput = {
  readonly authorize: TransferAuthorization;
  readonly iceServers: readonly IceServerDescriptor[];
  readonly materialLibrary: MaterialLibrary;
  readonly maxChunkBytes: number;
  readonly onError: (error: Error) => void;
  readonly onSignal: (signal: WebRtcUploadSignal) => void;
  readonly uploadId: UploadId;
};

export type WebRtcUploadSessionFactory = (
  input: WebRtcUploadSessionFactoryInput,
) => WebRtcUploadSession;

export type CreatedUploadSession = {
  readonly expiresAtEpochMs: number;
  readonly iceServers: readonly IceServerDescriptor[];
  readonly macSignalingToken: string;
  readonly mobileSignalingToken: string;
  readonly sessionId: WebRtcSessionId;
  readonly transferGrant: string;
};

export type SignalingAcceptance =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "rejected";
      readonly reason: "SESSION_EXPIRED" | "SESSION_UNKNOWN";
    };

export interface UploadSessionCoordinator {
  accept(message: SignalingMessage): SignalingAcceptance;
  abort(sessionId: WebRtcSessionId): void;
  close(sessionId: WebRtcSessionId, reason: SignalingCloseReason): void;
  closeExpired(): number;
  create(input: {
    readonly deviceId: DeviceId;
    readonly iceServers?: readonly IceServerDescriptor[];
    readonly uploadId: UploadId;
  }): CreatedUploadSession;
}

/** Coordinates one locally-authorized material transfer with its Cloudflare signaling session. */
export function createUploadSessionCoordinator(input: {
  readonly createWebRtcSession?: WebRtcUploadSessionFactory;
  /** Compatibility default for local callers; remote uploads provide fresh session credentials. */
  readonly iceServers?: readonly IceServerDescriptor[];
  readonly materialLibrary: MaterialLibrary;
  readonly maxChunkBytes: number;
  readonly nowEpochMs: () => number;
  readonly onError?: (error: Error) => void;
  readonly onOutboundSignal: (message: SignalingMessage) => void;
  readonly signalingSecret: string;
  readonly tokenLifetimeMs: number;
}): UploadSessionCoordinator {
  assertTokenLifetime(input.tokenLifetimeMs);
  return new InMemoryUploadSessionCoordinator({
    ...input,
    createWebRtcSession: input.createWebRtcSession ?? createWebRtcUploadSession,
    iceServers: input.iceServers ?? [],
    onError: input.onError ?? (() => undefined),
  });
}

class InMemoryUploadSessionCoordinator implements UploadSessionCoordinator {
  private readonly sessions = new Map<WebRtcSessionId, ActiveUploadSession>();

  constructor(
    private readonly input: {
      readonly createWebRtcSession: WebRtcUploadSessionFactory;
      readonly iceServers: readonly IceServerDescriptor[];
      readonly materialLibrary: MaterialLibrary;
      readonly maxChunkBytes: number;
      readonly nowEpochMs: () => number;
      readonly onError: (error: Error) => void;
      readonly onOutboundSignal: (message: SignalingMessage) => void;
      readonly signalingSecret: string;
      readonly tokenLifetimeMs: number;
    },
  ) {}

  create(input: {
    readonly deviceId: DeviceId;
    readonly iceServers?: readonly IceServerDescriptor[];
    readonly uploadId: UploadId;
  }): CreatedUploadSession {
    this.closeExpired();
    if (
      this.input.materialLibrary.getUpload(input.uploadId).state !==
      "transferring"
    ) {
      throw new UploadSessionCoordinatorError("UPLOAD_NOT_TRANSFERABLE");
    }
    if (
      this.input.materialLibrary.getPairedDevice(input.deviceId) === undefined
    ) {
      throw new UploadSessionCoordinatorError("DEVICE_NOT_PAIRED");
    }
    const sessionId = webRtcSessionIdSchema.parse(randomUUID());
    const expiresAtEpochMs = this.expiresAtEpochMs();
    const transferGrant = randomBytes(32).toString("base64url");
    const session = this.input.createWebRtcSession({
      authorize: createPairedDeviceAuthorization({
        expectedDeviceId: input.deviceId,
        expectedGrant: transferGrant,
        getPairedDevice: (deviceId) =>
          this.input.materialLibrary.getPairedDevice(deviceId),
        sessionId,
        uploadId: input.uploadId,
      }),
      iceServers: input.iceServers ?? this.input.iceServers,
      materialLibrary: this.input.materialLibrary,
      maxChunkBytes: this.input.maxChunkBytes,
      onError: this.input.onError,
      onSignal: (signal) => this.forwardLocalSignal(sessionId, signal),
      uploadId: input.uploadId,
    });
    this.sessions.set(sessionId, { expiresAtEpochMs, session });
    return {
      expiresAtEpochMs,
      iceServers: input.iceServers ?? this.input.iceServers,
      macSignalingToken: this.signalingToken(
        "mac",
        sessionId,
        expiresAtEpochMs,
      ),
      mobileSignalingToken: this.signalingToken(
        "mobile",
        sessionId,
        expiresAtEpochMs,
      ),
      sessionId,
      transferGrant,
    };
  }

  accept(message: SignalingMessage): SignalingAcceptance {
    const active = this.sessions.get(message.sessionId);
    if (active === undefined) {
      return { kind: "rejected", reason: "SESSION_UNKNOWN" };
    }
    if (active.expiresAtEpochMs <= this.input.nowEpochMs()) {
      active.session.close();
      this.sessions.delete(message.sessionId);
      return { kind: "rejected", reason: "SESSION_EXPIRED" };
    }
    switch (message.type) {
      case "candidate":
        active.session.acceptRemoteCandidate({
          candidate: message.candidate,
          mid: message.mid,
        });
        return { kind: "accepted" };
      case "description":
        active.session.acceptRemoteDescription({
          descriptionType: message.descriptionType,
          sdp: message.sdp,
        });
        return { kind: "accepted" };
      case "close":
        active.session.close();
        this.sessions.delete(message.sessionId);
        return { kind: "accepted" };
      default:
        return assertNever(message);
    }
  }

  close(sessionId: WebRtcSessionId, reason: SignalingCloseReason): void {
    const active = this.sessions.get(sessionId);
    if (active === undefined) {
      return;
    }
    active.session.close();
    this.sessions.delete(sessionId);
    try {
      this.input.onOutboundSignal({ reason, sessionId, type: "close" });
    } catch (error) {
      if (error instanceof Error) {
        this.input.onError(error);
        return;
      }
      this.input.onError(
        new UploadSessionCoordinatorError("OUTBOUND_SIGNAL_DELIVERY_FAILED"),
      );
    }
  }

  abort(sessionId: WebRtcSessionId): void {
    const active = this.sessions.get(sessionId);
    if (active === undefined) {
      return;
    }
    active.session.close();
    this.sessions.delete(sessionId);
  }

  closeExpired(): number {
    const nowEpochMs = this.input.nowEpochMs();
    let closed = 0;
    for (const [sessionId, active] of this.sessions) {
      if (active.expiresAtEpochMs <= nowEpochMs) {
        active.session.close();
        this.sessions.delete(sessionId);
        closed += 1;
      }
    }
    return closed;
  }

  private expiresAtEpochMs(): number {
    const expiresAtEpochMs =
      this.input.nowEpochMs() + this.input.tokenLifetimeMs;
    if (!Number.isSafeInteger(expiresAtEpochMs)) {
      throw new UploadSessionCoordinatorError("TOKEN_EXPIRY_OVERFLOW");
    }
    return expiresAtEpochMs;
  }

  private forwardLocalSignal(
    sessionId: WebRtcSessionId,
    signal: WebRtcUploadSignal,
  ): void {
    switch (signal.kind) {
      case "candidate":
        this.input.onOutboundSignal({
          candidate: signal.candidate,
          mid: signal.mid,
          sessionId,
          type: "candidate",
        });
        return;
      case "description":
        this.forwardLocalDescription(sessionId, signal);
        return;
      case "state":
        this.closeFailedDirectSession(sessionId, signal.state);
        return;
      default:
        assertNever(signal);
    }
  }

  private closeFailedDirectSession(
    sessionId: WebRtcSessionId,
    state: string,
  ): void {
    if (state !== "failed") {
      return;
    }
    this.close(sessionId, "CONNECTION_FAILED");
  }

  private signalingToken(
    role: "mac" | "mobile",
    sessionId: WebRtcSessionId,
    expiresAtEpochMs: number,
  ): string {
    return createSignalingToken({
      payload: { expiresAtEpochMs, role, sessionId },
      secret: this.input.signalingSecret,
    });
  }

  private forwardLocalDescription(
    sessionId: WebRtcSessionId,
    signal: Extract<WebRtcUploadSignal, { readonly kind: "description" }>,
  ): void {
    switch (signal.descriptionType) {
      case "answer":
      case "offer":
        this.input.onOutboundSignal({
          descriptionType: signal.descriptionType,
          sdp: signal.sdp,
          sessionId,
          type: "description",
        });
        return;
      case "pranswer":
      case "rollback":
      case "unspec":
        this.input.onError(
          new UploadSessionCoordinatorError("UNSUPPORTED_LOCAL_DESCRIPTION"),
        );
        return;
      default:
        assertNever(signal.descriptionType);
    }
  }
}

type ActiveUploadSession = {
  readonly expiresAtEpochMs: number;
  readonly session: WebRtcUploadSession;
};

function assertTokenLifetime(tokenLifetimeMs: number): void {
  if (!Number.isSafeInteger(tokenLifetimeMs) || tokenLifetimeMs < 1) {
    throw new UploadSessionCoordinatorError("INVALID_TOKEN_LIFETIME");
  }
}

function assertNever(_value: never): never {
  throw new UploadSessionCoordinatorError("INVALID_TOKEN_LIFETIME");
}
