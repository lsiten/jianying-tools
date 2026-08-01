import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createSystemProxyWebSocket } from "./system-proxy-websocket.js";

describe("system proxy WebSocket", () => {
  let server = createServer();
  let upgradedSocket: { destroy(): void } | undefined;

  afterEach(async () => {
    upgradedSocket?.destroy();
    upgradedSocket = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    server = createServer();
    vi.unstubAllEnvs();
  });

  test("opens a direct connection when the destination is excluded from proxying", async () => {
    // Given: a local Worker-compatible WebSocket endpoint excluded by the system proxy policy.
    server.on("upgrade", (request, socket) => {
      upgradedSocket = socket;
      const key = request.headers["sec-websocket-key"];
      expect(typeof key).toBe("string");
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }
    vi.stubEnv("NO_PROXY", "127.0.0.1");

    // When: the local server opens its outbound WebSocket through the system policy.
    const socket = createSystemProxyWebSocket(`ws://127.0.0.1:${address.port}`);

    // Then: the agent honors the local no-proxy route and reaches the endpoint.
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket did not open"));
    });
    expect(socket.readyState).toBe(1);
    socket.close();
  });
});
