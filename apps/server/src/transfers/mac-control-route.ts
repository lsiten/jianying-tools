import { createHmac } from "node:crypto";
import {
  controlNodeIdSchema,
  controlTokenPayloadSchema,
  type RemoteControlMacResponse,
  type RemoteControlMobileRequest,
  remoteControlMobileRequestSchema,
} from "@jianying/contracts";
import type { WebSocket as UndiciWebSocket } from "undici";

import { createSystemProxyWebSocket } from "./system-proxy-websocket.js";

export const MAC_CONTROL_ROUTE_ERROR_REASONS = {
  CONNECTION_CLOSED: "CONNECTION_CLOSED",
  INVALID_WORKER_URL: "INVALID_WORKER_URL",
  INVALID_WORKER_MESSAGE: "INVALID_WORKER_MESSAGE",
} as const;

export class MacControlRouteError extends Error {
  readonly name = "MacControlRouteError";

  constructor(
    readonly reason: (typeof MAC_CONTROL_ROUTE_ERROR_REASONS)[keyof typeof MAC_CONTROL_ROUTE_ERROR_REASONS],
  ) {
    super(`Mac control route failed: ${reason}`);
  }
}

export interface MacControlRoute {
  send(response: RemoteControlMacResponse): void;
  start(): void;
  stop(): void;
}

export interface MacControlSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((data: unknown) => void) | null;
  onopen: (() => void) | null;
  readonly readyState: number;
  send(data: string): void;
}

/** Maintains the authenticated Mac half of the public H5 control rendezvous. */
export function createMacControlRoute(input: {
  readonly connectTimeoutMs: number;
  readonly createSocket?: (url: string) => MacControlSocket;
  readonly nodeId: string;
  readonly nowEpochMs: () => number;
  readonly onError?: (error: MacControlRouteError) => void;
  readonly onRequest: (request: RemoteControlMobileRequest) => void;
  readonly secret: string;
  readonly workerBaseUrl: string;
}): MacControlRoute {
  controlNodeIdSchema.parse(input.nodeId);
  return new DefaultMacControlRoute(
    input,
    input.createSocket ?? createGlobalControlSocket,
  );
}

class DefaultMacControlRoute implements MacControlRoute {
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: MacControlSocket | undefined;
  private stopped = true;

  constructor(
    private readonly input: {
      readonly connectTimeoutMs: number;
      readonly nodeId: string;
      readonly nowEpochMs: () => number;
      readonly onError?: (error: MacControlRouteError) => void;
      readonly onRequest: (request: RemoteControlMobileRequest) => void;
      readonly secret: string;
      readonly workerBaseUrl: string;
    },
    private readonly createSocket: (url: string) => MacControlSocket,
  ) {}

  send(response: RemoteControlMacResponse): void {
    if (this.socket?.readyState !== 1) {
      this.report("CONNECTION_CLOSED");
      return;
    }
    this.socket.send(JSON.stringify(response));
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    let socket: MacControlSocket;
    try {
      socket = this.createSocket(this.createControlUrl());
    } catch (error) {
      if (error instanceof MacControlRouteError) {
        this.report(error.reason);
      } else {
        this.report("CONNECTION_CLOSED");
      }
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => undefined;
    socket.onmessage = (data) => this.receive(data);
    socket.onerror = () => this.report("CONNECTION_CLOSED");
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.scheduleReconnect();
    };
  }

  private createControlUrl(): string {
    let url: URL;
    try {
      url = new URL(this.input.workerBaseUrl);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new MacControlRouteError("INVALID_WORKER_URL");
      }
      throw error;
    }
    if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      throw new MacControlRouteError("INVALID_WORKER_URL");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/control/${this.input.nodeId}`;
    url.search = "";
    url.searchParams.set("token", this.controlToken());
    return url.toString();
  }

  private controlToken(): string {
    const payload = controlTokenPayloadSchema.parse({
      expiresAtEpochMs: this.input.nowEpochMs() + 43_200_000,
      nodeId: this.input.nodeId,
      role: "mac",
    });
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.input.secret)
      .update(encodedPayload)
      .digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") {
      this.report("INVALID_WORKER_MESSAGE");
      return;
    }
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(data);
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.report("INVALID_WORKER_MESSAGE");
        return;
      }
      throw error;
    }
    const parsed = remoteControlMobileRequestSchema.safeParse(rawMessage);
    if (!parsed.success) {
      this.report("INVALID_WORKER_MESSAGE");
      return;
    }
    this.input.onRequest(parsed.data);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.input.connectTimeoutMs);
  }

  private report(
    reason: (typeof MAC_CONTROL_ROUTE_ERROR_REASONS)[keyof typeof MAC_CONTROL_ROUTE_ERROR_REASONS],
  ): void {
    this.input.onError?.(new MacControlRouteError(reason));
  }
}

class GlobalMacControlSocket implements MacControlSocket {
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(private readonly socket: UndiciWebSocket) {
    socket.addEventListener("close", () => this.onclose?.());
    socket.addEventListener("error", () => this.onerror?.());
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

function createGlobalControlSocket(url: string): MacControlSocket {
  return new GlobalMacControlSocket(createSystemProxyWebSocket(url));
}
