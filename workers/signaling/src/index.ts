/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import {
  controlNodeIdSchema,
  type SignalingRole,
  signalingMessageSchema,
  signalingRoleSchema,
  webRtcSessionIdSchema,
} from "@jianying/contracts";
import { ControlRoom } from "./control-room.js";
import { verifyControlToken } from "./control-token.js";
import { verifySignalingToken } from "./signaling-token.js";
import {
  forwardTurnCredentialRequest,
  requestCloudflareTurnCredentials,
} from "./turn-credential-route.js";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly SIGNALING_HMAC_SECRET: string;
  readonly TURN_API_TOKEN: string;
  readonly TURN_KEY_ID: string;
  readonly CONTROL_ROOM: DurableObjectNamespace<ControlRoom>;
  readonly SIGNALING_ROOM: DurableObjectNamespace<SignalingRoom>;
}

export const SIGNALING_ERROR_CODES = {
  INVALID_SESSION: "INVALID_SESSION",
  TOKEN_REJECTED: "TOKEN_REJECTED",
  TURN_CREDENTIAL_REQUEST_FAILED: "TURN_CREDENTIAL_REQUEST_FAILED",
  TURN_REQUEST_INVALID: "TURN_REQUEST_INVALID",
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
} as const;

export class SignalingRoom extends DurableObject<Env> {
  fetch(request: Request): Response {
    const role = signalingRoleSchema.safeParse(
      request.headers.get("x-jianying-signaling-role"),
    );
    const sessionId = webRtcSessionIdSchema.safeParse(
      request.headers.get("x-jianying-signaling-session"),
    );
    const expiresAtEpochMs = Number(
      request.headers.get("x-jianying-signaling-expiry"),
    );
    if (
      !role.success ||
      !sessionId.success ||
      !Number.isSafeInteger(expiresAtEpochMs)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    for (const existingSocket of this.ctx.getWebSockets(roleTag(role.data))) {
      existingSocket.close(4001, "Superseded by a newer signaling connection");
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [
      roleTag(role.data),
      sessionTag(sessionId.data),
      expiryTag(expiresAtEpochMs),
    ]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      socket.close(1003, "Signaling messages must be JSON text");
      return;
    }
    const context = socketContext(this.ctx.getTags(socket));
    if (context === undefined || context.expiresAtEpochMs <= Date.now()) {
      socket.close(4003, "Signaling token expired");
      return;
    }
    const signalingMessage = parseSignalingMessage(message);
    if (
      signalingMessage === undefined ||
      signalingMessage.sessionId !== context.sessionId
    ) {
      socket.close(1008, "Invalid signaling message");
      return;
    }
    const targetRole = oppositeRole(context.role);
    for (const targetSocket of this.ctx.getWebSockets(roleTag(targetRole))) {
      targetSocket.send(message);
    }
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Signaling socket error");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const turnNodeId = controlNodeIdSchema.safeParse(
      url.pathname.replace("/v1/turn/", ""),
    );
    if (url.pathname.startsWith("/v1/turn/")) {
      if (!turnNodeId.success) {
        return jsonError(SIGNALING_ERROR_CODES.INVALID_SESSION, 404);
      }
      if (request.method !== "POST") {
        return jsonError(SIGNALING_ERROR_CODES.TURN_REQUEST_INVALID, 405);
      }
      return forwardTurnCredentialRequest({
        nodeId: turnNodeId.data,
        nowEpochMs: Date.now(),
        request,
        requestCredentials: requestCloudflareTurnCredentials,
        secret: env.SIGNALING_HMAC_SECRET,
        turnApiToken: env.TURN_API_TOKEN,
        turnKeyId: env.TURN_KEY_ID,
      });
    }
    const controlNodeId = controlNodeIdSchema.safeParse(
      url.pathname.replace("/v1/control/", ""),
    );
    if (url.pathname.startsWith("/v1/control/") && controlNodeId.success) {
      return forwardControlConnection(request, env, controlNodeId.data);
    }
    const sessionId = webRtcSessionIdSchema.safeParse(
      url.pathname.replace("/v1/signal/", ""),
    );
    if (!url.pathname.startsWith("/v1/signal/")) {
      return env.ASSETS.fetch(
        url.pathname === "/"
          ? new Request(
              rewritePathname(url, "/mobile-upload-entry.html"),
              request,
            )
          : request,
      );
    }
    if (!sessionId.success) {
      return jsonError(SIGNALING_ERROR_CODES.INVALID_SESSION, 404);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonError(SIGNALING_ERROR_CODES.UPGRADE_REQUIRED, 426);
    }
    const token = url.searchParams.get("token");
    if (token === null) {
      return jsonError(SIGNALING_ERROR_CODES.TOKEN_REJECTED, 401);
    }
    const verification = await verifySignalingToken({
      nowEpochMs: Date.now(),
      secret: env.SIGNALING_HMAC_SECRET,
      sessionId: sessionId.data,
      token,
    });
    if (verification.kind === "rejected") {
      return jsonError(verification.reason, 401);
    }

    const headers = new Headers(request.headers);
    headers.set("x-jianying-signaling-role", verification.payload.role);
    headers.set("x-jianying-signaling-session", verification.payload.sessionId);
    headers.set(
      "x-jianying-signaling-expiry",
      String(verification.payload.expiresAtEpochMs),
    );
    const roomId = env.SIGNALING_ROOM.idFromName(
      verification.payload.sessionId,
    );
    return env.SIGNALING_ROOM.get(roomId).fetch(
      new Request(request, { headers }),
    );
  },
} satisfies ExportedHandler<Env>;

export { ControlRoom };

async function forwardControlConnection(
  request: Request,
  env: Env,
  nodeId: string,
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return jsonError(SIGNALING_ERROR_CODES.UPGRADE_REQUIRED, 426);
  }
  const token = new URL(request.url).searchParams.get("token");
  const headers = new Headers(request.headers);
  if (token === null) {
    headers.set("x-jianying-control-role", "mobile");
  } else {
    const verification = await verifyControlToken({
      nodeId,
      nowEpochMs: Date.now(),
      secret: env.SIGNALING_HMAC_SECRET,
      token,
    });
    if (verification.kind === "rejected") {
      return jsonError(SIGNALING_ERROR_CODES.TOKEN_REJECTED, 401);
    }
    headers.set("x-jianying-control-role", "mac");
  }
  const roomId = env.CONTROL_ROOM.idFromName(nodeId);
  return env.CONTROL_ROOM.get(roomId).fetch(new Request(request, { headers }));
}

function jsonError(code: string, status: number): Response {
  return Response.json({ code }, { status });
}

function rewritePathname(url: URL, pathname: string): URL {
  const rewritten = new URL(url);
  rewritten.pathname = pathname;
  return rewritten;
}

function parseSignalingMessage(message: string) {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(message);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  const parsed = signalingMessageSchema.safeParse(rawMessage);
  return parsed.success ? parsed.data : undefined;
}

function socketContext(tags: readonly string[]):
  | {
      readonly expiresAtEpochMs: number;
      readonly role: SignalingRole;
      readonly sessionId: string;
    }
  | undefined {
  const role = signalingRoleSchema.safeParse(tagValue(tags, "role:"));
  const sessionId = webRtcSessionIdSchema.safeParse(tagValue(tags, "session:"));
  const expiresAtEpochMs = Number(tagValue(tags, "expires:"));
  if (
    !role.success ||
    !sessionId.success ||
    !Number.isSafeInteger(expiresAtEpochMs)
  ) {
    return undefined;
  }
  return { expiresAtEpochMs, role: role.data, sessionId: sessionId.data };
}

function tagValue(tags: readonly string[], prefix: string): string | undefined {
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function roleTag(role: SignalingRole): string {
  return `role:${role}`;
}

function sessionTag(sessionId: string): string {
  return `session:${sessionId}`;
}

function expiryTag(expiresAtEpochMs: number): string {
  return `expires:${expiresAtEpochMs}`;
}

function oppositeRole(role: SignalingRole): SignalingRole {
  return role === "mac" ? "mobile" : "mac";
}
