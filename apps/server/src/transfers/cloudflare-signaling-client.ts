import {
  type SignalingMessage,
  signalingMessageSchema,
  type WebRtcSessionId,
} from "@jianying/contracts";
import type { WebSocket as UndiciWebSocket } from "undici";

import { createSystemProxyWebSocket } from "./system-proxy-websocket.js";

export const CLOUD_FLARE_SIGNALING_CLIENT_ERROR_REASONS = {
  CONNECTION_CLOSED: "CONNECTION_CLOSED",
  CONNECTION_TIMEOUT: "CONNECTION_TIMEOUT",
  INVALID_WORKER_URL: "INVALID_WORKER_URL",
  SESSION_MISMATCH: "SESSION_MISMATCH",
  SIGNALING_MESSAGE_INVALID: "SIGNALING_MESSAGE_INVALID",
  SOCKET_ERROR: "SOCKET_ERROR",
} as const;

export type CloudflareSignalingClientErrorReason =
  (typeof CLOUD_FLARE_SIGNALING_CLIENT_ERROR_REASONS)[keyof typeof CLOUD_FLARE_SIGNALING_CLIENT_ERROR_REASONS];

export class CloudflareSignalingClientError extends Error {
  readonly name = "CloudflareSignalingClientError";

  constructor(readonly reason: CloudflareSignalingClientErrorReason) {
    super(`Cloudflare signaling client failed: ${reason}`);
  }
}

export interface SignalingSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: ((error: Error) => void) | null;
  onmessage: ((data: unknown) => void) | null;
  onopen: (() => void) | null;
  readonly readyState: number;
  send(data: string): void;
}

export interface CloudflareSignalingConnection {
  close(): void;
  send(message: SignalingMessage): void;
}

export interface CloudflareSignalingClient {
  connect(input: {
    readonly onError?: (error: CloudflareSignalingClientError) => void;
    readonly onMessage: (message: SignalingMessage) => void;
    readonly sessionId: WebRtcSessionId;
    readonly token: string;
    readonly workerBaseUrl: string;
  }): Promise<CloudflareSignalingConnection>;
}

/** Opens a session-scoped WSS connection that can only relay shared signaling contract messages. */
export function createCloudflareSignalingClient(input: {
  readonly connectTimeoutMs: number;
  readonly createSocket?: (url: string) => SignalingSocket;
}): CloudflareSignalingClient {
  assertConnectTimeout(input.connectTimeoutMs);
  return new DefaultCloudflareSignalingClient(
    input.connectTimeoutMs,
    input.createSocket ?? createGlobalWebSocket,
  );
}

class DefaultCloudflareSignalingClient implements CloudflareSignalingClient {
  constructor(
    private readonly connectTimeoutMs: number,
    private readonly createSocket: (url: string) => SignalingSocket,
  ) {}

  connect(input: {
    readonly onError?: (error: CloudflareSignalingClientError) => void;
    readonly onMessage: (message: SignalingMessage) => void;
    readonly sessionId: WebRtcSessionId;
    readonly token: string;
    readonly workerBaseUrl: string;
  }): Promise<CloudflareSignalingConnection> {
    const url = createSignalingUrl(
      input.workerBaseUrl,
      input.sessionId,
      input.token,
    );
    const socket = this.createSocket(url);
    const connection = new DefaultCloudflareSignalingConnection(
      socket,
      input.sessionId,
      input.onMessage,
      input.onError ?? (() => undefined),
    );
    return connection.open(this.connectTimeoutMs);
  }
}

class DefaultCloudflareSignalingConnection
  implements CloudflareSignalingConnection
{
  private opened = false;
  private closed = false;

  constructor(
    private readonly socket: SignalingSocket,
    private readonly sessionId: WebRtcSessionId,
    private readonly onMessage: (message: SignalingMessage) => void,
    private readonly onError: (error: CloudflareSignalingClientError) => void,
  ) {}

  open(timeoutMs: number): Promise<CloudflareSignalingConnection> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.closed = true;
        this.socket.close();
        reject(new CloudflareSignalingClientError("CONNECTION_TIMEOUT"));
      }, timeoutMs);
      this.socket.onopen = () => {
        if (this.closed) {
          return;
        }
        clearTimeout(timeout);
        this.opened = true;
        resolve(this);
      };
      this.socket.onmessage = (data) => this.receive(data);
      this.socket.onerror = () => {
        clearTimeout(timeout);
        if (this.opened) {
          this.closeWithError("SOCKET_ERROR");
          return;
        }
        this.closed = true;
        reject(new CloudflareSignalingClientError("SOCKET_ERROR"));
      };
      this.socket.onclose = () => {
        clearTimeout(timeout);
        if (this.closed) {
          return;
        }
        this.closed = true;
        if (this.opened) {
          this.onError(new CloudflareSignalingClientError("CONNECTION_CLOSED"));
          return;
        }
        reject(new CloudflareSignalingClientError("CONNECTION_CLOSED"));
      };
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.close();
  }

  send(message: SignalingMessage): void {
    if (!this.opened || this.closed || this.socket.readyState !== 1) {
      throw new CloudflareSignalingClientError("CONNECTION_CLOSED");
    }
    if (message.sessionId !== this.sessionId) {
      throw new CloudflareSignalingClientError("SESSION_MISMATCH");
    }
    this.socket.send(JSON.stringify(message));
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") {
      this.closeWithError("SIGNALING_MESSAGE_INVALID");
      return;
    }
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(data);
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.closeWithError("SIGNALING_MESSAGE_INVALID");
        return;
      }
      throw error;
    }
    const parsed = signalingMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      this.closeWithError("SIGNALING_MESSAGE_INVALID");
      return;
    }
    if (parsed.data.sessionId !== this.sessionId) {
      this.closeWithError("SESSION_MISMATCH");
      return;
    }
    this.onMessage(parsed.data);
  }

  private closeWithError(reason: CloudflareSignalingClientErrorReason): void {
    this.onError(new CloudflareSignalingClientError(reason));
    this.close();
  }
}

class GlobalSignalingSocket implements SignalingSocket {
  onclose: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(private readonly socket: UndiciWebSocket) {
    socket.addEventListener("close", () => this.onclose?.());
    socket.addEventListener("error", () => {
      this.onerror?.(new CloudflareSignalingClientError("SOCKET_ERROR"));
    });
    socket.addEventListener("message", (event) => this.onmessage?.(event.data));
    socket.addEventListener("open", () => this.onopen?.());
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  close(): void {
    this.socket.close();
  }

  send(data: string): void {
    this.socket.send(data);
  }
}

function createGlobalWebSocket(url: string): SignalingSocket {
  return new GlobalSignalingSocket(createSystemProxyWebSocket(url));
}

function createSignalingUrl(
  workerBaseUrl: string,
  sessionId: WebRtcSessionId,
  token: string,
): string {
  let url: URL;
  try {
    url = new URL(workerBaseUrl);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CloudflareSignalingClientError("INVALID_WORKER_URL");
    }
    throw error;
  }
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new CloudflareSignalingClientError("INVALID_WORKER_URL");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/signal/${sessionId}`;
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

function assertConnectTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new CloudflareSignalingClientError("CONNECTION_TIMEOUT");
  }
}
