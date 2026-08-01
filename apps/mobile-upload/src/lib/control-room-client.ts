import {
  type RemoteControlMacResponse,
  type RemoteControlMobileRequest,
  remoteControlMacResponseSchema,
} from "@jianying/contracts";

export class ControlRoomClientError extends Error {
  readonly name = "ControlRoomClientError";

  constructor(
    readonly reason:
      | "CONNECTION_FAILED"
      | "INVALID_RESPONSE"
      | "REQUEST_TIMED_OUT"
      | "WORKER_URL_INVALID",
  ) {
    super(`Mobile control route failed: ${reason}`);
  }
}

export async function requestMacControl(input: {
  readonly nodeId: string;
  readonly request: RemoteControlMobileRequest;
  readonly timeoutMs?: number;
  readonly workerBaseUrl: string;
}): Promise<RemoteControlMacResponse> {
  const socket = new WebSocket(controlUrl(input.workerBaseUrl, input.nodeId));
  const timeoutMs = input.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(
      () => settle(reject, new ControlRoomClientError("REQUEST_TIMED_OUT")),
      timeoutMs,
    );

    const settle = <T>(complete: (value: T) => void, value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      socket.close();
      complete(value);
    };

    socket.onopen = () => socket.send(JSON.stringify(input.request));
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        settle(reject, new ControlRoomClientError("INVALID_RESPONSE"));
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch (error) {
        if (error instanceof SyntaxError) {
          settle(reject, new ControlRoomClientError("INVALID_RESPONSE"));
          return;
        }
        settle(reject, new ControlRoomClientError("INVALID_RESPONSE"));
        return;
      }
      const parsed = remoteControlMacResponseSchema.safeParse(decoded);
      if (
        !parsed.success ||
        parsed.data.requestId !== input.request.requestId
      ) {
        settle(reject, new ControlRoomClientError("INVALID_RESPONSE"));
        return;
      }
      settle(resolve, parsed.data);
    };
    socket.onerror = () =>
      settle(reject, new ControlRoomClientError("CONNECTION_FAILED"));
    socket.onclose = () => {
      if (!settled) {
        settle(reject, new ControlRoomClientError("CONNECTION_FAILED"));
      }
    };
  });
}

function controlUrl(workerBaseUrl: string, nodeId: string): string {
  let url: URL;
  try {
    url = new URL(workerBaseUrl);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ControlRoomClientError("WORKER_URL_INVALID");
    }
    throw error;
  }
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new ControlRoomClientError("WORKER_URL_INVALID");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/control/${nodeId}`;
  url.search = "";
  return url.toString();
}
