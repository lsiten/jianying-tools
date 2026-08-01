import type { SignalingMessage, WebRtcSessionId } from "@jianying/contracts";

import type {
  CloudflareSignalingClient,
  CloudflareSignalingClientError,
  CloudflareSignalingConnection,
} from "./cloudflare-signaling-client.js";

export const SESSION_SIGNALING_GATEWAY_ERROR_REASONS = {
  SESSION_ALREADY_CONNECTED: "SESSION_ALREADY_CONNECTED",
  SIGNALING_CONNECTION_UNAVAILABLE: "SIGNALING_CONNECTION_UNAVAILABLE",
} as const;

export type SessionSignalingGatewayErrorReason =
  (typeof SESSION_SIGNALING_GATEWAY_ERROR_REASONS)[keyof typeof SESSION_SIGNALING_GATEWAY_ERROR_REASONS];

export class SessionSignalingGatewayError extends Error {
  readonly name = "SessionSignalingGatewayError";

  constructor(readonly reason: SessionSignalingGatewayErrorReason) {
    super(`Session signaling gateway failed: ${reason}`);
  }
}

export interface SessionSignalingGateway {
  close(sessionId: WebRtcSessionId): void;
  connectMacSession(input: {
    readonly macSignalingToken: string;
    readonly onMessage: (message: SignalingMessage) => void;
    readonly onSessionError: (error: Error) => void;
    readonly sessionId: WebRtcSessionId;
  }): Promise<void>;
  forwardOutbound(message: SignalingMessage): void;
}

/** Owns the Mac-side Cloudflare socket for each active WebRTC session. */
export function createSessionSignalingGateway(input: {
  readonly signalingClient: CloudflareSignalingClient;
  readonly workerBaseUrl: string;
}): SessionSignalingGateway {
  return new DefaultSessionSignalingGateway(input);
}

class DefaultSessionSignalingGateway implements SessionSignalingGateway {
  private readonly connections = new Map<
    WebRtcSessionId,
    CloudflareSignalingConnection
  >();

  constructor(
    private readonly input: {
      readonly signalingClient: CloudflareSignalingClient;
      readonly workerBaseUrl: string;
    },
  ) {}

  async connectMacSession(input: {
    readonly macSignalingToken: string;
    readonly onMessage: (message: SignalingMessage) => void;
    readonly onSessionError: (error: Error) => void;
    readonly sessionId: WebRtcSessionId;
  }): Promise<void> {
    if (this.connections.has(input.sessionId)) {
      throw new SessionSignalingGatewayError("SESSION_ALREADY_CONNECTED");
    }
    let connection: CloudflareSignalingConnection | undefined;
    connection = await this.input.signalingClient.connect({
      onError: (error) =>
        this.handleConnectionError(input.sessionId, connection, error, input),
      onMessage: input.onMessage,
      sessionId: input.sessionId,
      token: input.macSignalingToken,
      workerBaseUrl: this.input.workerBaseUrl,
    });
    this.connections.set(input.sessionId, connection);
  }

  close(sessionId: WebRtcSessionId): void {
    const connection = this.connections.get(sessionId);
    if (connection === undefined) {
      return;
    }
    this.connections.delete(sessionId);
    connection.close();
  }

  forwardOutbound(message: SignalingMessage): void {
    const connection = this.connections.get(message.sessionId);
    if (connection === undefined) {
      throw new SessionSignalingGatewayError(
        "SIGNALING_CONNECTION_UNAVAILABLE",
      );
    }
    try {
      connection.send(message);
    } catch (error) {
      this.connections.delete(message.sessionId);
      throw error;
    }
    if (message.type === "close") {
      this.close(message.sessionId);
    }
  }

  private handleConnectionError(
    sessionId: WebRtcSessionId,
    connection: CloudflareSignalingConnection | undefined,
    error: CloudflareSignalingClientError,
    input: {
      readonly onSessionError: (error: Error) => void;
    },
  ): void {
    if (
      connection !== undefined &&
      this.connections.get(sessionId) === connection
    ) {
      this.connections.delete(sessionId);
    }
    input.onSessionError(error);
  }
}
