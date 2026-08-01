/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import {
  type RemoteControlMacResponse,
  remoteControlMacResponseSchema,
  remoteControlMobileRequestSchema,
} from "@jianying/contracts";

const CONTROL_ROLE = { MAC: "mac", MOBILE: "mobile" } as const;
type ControlRole = (typeof CONTROL_ROLE)[keyof typeof CONTROL_ROLE];

const MAX_PENDING_REQUESTS_PER_SOCKET = 8;

export class ControlRoom extends DurableObject {
  private readonly pendingRequestSockets = new Map<string, WebSocket>();

  fetch(request: Request): Response {
    const role = controlRole(request.headers.get("x-jianying-control-role"));
    if (role === undefined) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if (role === CONTROL_ROLE.MAC) {
      for (const existingSocket of this.ctx.getWebSockets(roleTag(role))) {
        existingSocket.close(4001, "Superseded by a newer Mac control route");
      }
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [roleTag(role)]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketClose(socket: WebSocket): void {
    this.removePendingRequests(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.removePendingRequests(socket);
    socket.close(1011, "Control socket error");
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      socket.close(1003, "Control messages must be JSON text");
      return;
    }
    const role = socketRole(this.ctx.getTags(socket));
    if (role === undefined) {
      socket.close(1008, "Invalid control role");
      return;
    }
    if (role === CONTROL_ROLE.MAC) {
      this.forwardMacResponse(message);
      return;
    }
    this.forwardMobileRequest(socket, message);
  }

  private forwardMacResponse(message: string): void {
    const response = parseMacResponse(message);
    if (response === undefined) {
      return;
    }
    const socket = this.pendingRequestSockets.get(response.requestId);
    if (socket === undefined) {
      return;
    }
    this.pendingRequestSockets.delete(response.requestId);
    socket.send(message);
  }

  private forwardMobileRequest(socket: WebSocket, message: string): void {
    const request = parseMobileRequest(message);
    if (request === undefined) {
      socket.close(1008, "Invalid mobile control message");
      return;
    }
    if (
      this.pendingRequestSockets.has(request.requestId) ||
      this.countPendingRequests(socket) >= MAX_PENDING_REQUESTS_PER_SOCKET
    ) {
      socket.close(1008, "Too many pending control requests");
      return;
    }
    const macSocket = this.ctx.getWebSockets(roleTag(CONTROL_ROLE.MAC))[0];
    if (macSocket === undefined) {
      socket.send(
        JSON.stringify({
          reason: "PROJECT_UPLOAD_KEY_REJECTED",
          requestId: request.requestId,
          type: "project_upload_key_redeem_rejected",
        }),
      );
      return;
    }
    this.pendingRequestSockets.set(request.requestId, socket);
    macSocket.send(message);
  }

  private countPendingRequests(socket: WebSocket): number {
    let count = 0;
    for (const pendingSocket of this.pendingRequestSockets.values()) {
      if (pendingSocket === socket) {
        count += 1;
      }
    }
    return count;
  }

  private removePendingRequests(socket: WebSocket): void {
    for (const [requestId, pendingSocket] of this.pendingRequestSockets) {
      if (pendingSocket === socket) {
        this.pendingRequestSockets.delete(requestId);
      }
    }
  }
}

function controlRole(value: string | null): ControlRole | undefined {
  return value === CONTROL_ROLE.MAC || value === CONTROL_ROLE.MOBILE
    ? value
    : undefined;
}

function roleTag(role: ControlRole): string {
  return `control-role:${role}`;
}

function socketRole(tags: readonly string[]): ControlRole | undefined {
  const tag = tags.find((candidate) => candidate.startsWith("control-role:"));
  return controlRole(tag?.slice("control-role:".length) ?? null);
}

function parseMacResponse(
  message: string,
): RemoteControlMacResponse | undefined {
  const parsed = parseJson(message);
  if (parsed === undefined) {
    return undefined;
  }
  const result = remoteControlMacResponseSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function parseMobileRequest(message: string) {
  const parsed = parseJson(message);
  if (parsed === undefined) {
    return undefined;
  }
  const result = remoteControlMobileRequestSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function parseJson(message: string): unknown | undefined {
  try {
    return JSON.parse(message);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}
