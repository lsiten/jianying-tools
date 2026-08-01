import {
  SIGNALING_MESSAGE_TYPES,
  type SignalingMessage,
  signalingMessageSchema,
  type WebRtcSessionId,
} from "@jianying/contracts";

import type { TransferControlInbox } from "./transfer-control-inbox.js";
import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";

export type MobileSignalingClient = {
  readonly close: () => void;
  readonly opened: Promise<void>;
  readonly send: (message: SignalingMessage) => void;
};

export type MobileSignalingPeer = Pick<
  RTCPeerConnection,
  "addIceCandidate" | "setRemoteDescription"
>;

export function openMobileSignalingClient(input: {
  readonly inbox: TransferControlInbox;
  readonly peer: MobileSignalingPeer;
  readonly sessionId: WebRtcSessionId;
  readonly token: string;
  readonly workerBaseUrl: string;
}): MobileSignalingClient {
  const socket = new WebSocket(signalingUrl(input));
  const reportConnectionFailure = () => {
    input.inbox.reject(new WebRtcFileTransferError("CONNECTION_FAILED"));
  };
  const opened = socketOpened(socket, reportConnectionFailure);
  socket.onmessage = (event) => {
    void acceptSignalingMessage(input.peer, event.data).catch(
      (error: unknown) => {
        input.inbox.reject(toSignalingError(error));
      },
    );
  };
  socket.onclose = reportConnectionFailure;
  return {
    close: () => socket.close(),
    opened,
    send: (message) => socket.send(JSON.stringify(message)),
  };
}

async function acceptSignalingMessage(
  peer: MobileSignalingPeer,
  rawMessage: unknown,
): Promise<void> {
  if (typeof rawMessage !== "string") {
    throw new WebRtcFileTransferError("SIGNALING_INVALID");
  }
  const message = parseSignalingMessage(rawMessage);
  switch (message.type) {
    case SIGNALING_MESSAGE_TYPES.CANDIDATE:
      await peer.addIceCandidate({
        candidate: message.candidate,
        sdpMid: message.mid,
      });
      return;
    case SIGNALING_MESSAGE_TYPES.DESCRIPTION:
      await peer.setRemoteDescription({
        sdp: message.sdp,
        type: message.descriptionType,
      });
      return;
    case SIGNALING_MESSAGE_TYPES.CLOSE:
      throw new WebRtcFileTransferError("CONNECTION_FAILED");
    default:
      return assertNever(message);
  }
}

function socketOpened(
  socket: WebSocket,
  reportConnectionFailure: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let isOpened = false;
    const timeout = setTimeout(() => {
      reportConnectionFailure();
      reject(new WebRtcFileTransferError("SIGNALING_TIMED_OUT"));
    }, 30_000);
    socket.onopen = () => {
      isOpened = true;
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reportConnectionFailure();
      if (!isOpened) {
        reject(new WebRtcFileTransferError("CONNECTION_FAILED"));
      }
    };
    socket.addEventListener(
      "close",
      () => {
        if (!isOpened) {
          clearTimeout(timeout);
          reportConnectionFailure();
          reject(new WebRtcFileTransferError("CONNECTION_FAILED"));
        }
      },
      { once: true },
    );
  });
}

function signalingUrl(input: {
  readonly sessionId: WebRtcSessionId;
  readonly token: string;
  readonly workerBaseUrl: string;
}): string {
  const url = new URL(input.workerBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/signal/${input.sessionId}`;
  url.search = "";
  url.searchParams.set("token", input.token);
  return url.toString();
}

function parseSignalingMessage(value: string): SignalingMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WebRtcFileTransferError("SIGNALING_INVALID");
    }
    throw error;
  }
  const parsed = signalingMessageSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new WebRtcFileTransferError("SIGNALING_INVALID");
  }
  return parsed.data;
}

function toSignalingError(error: unknown): WebRtcFileTransferError {
  if (error instanceof WebRtcFileTransferError) {
    return error;
  }
  return new WebRtcFileTransferError("CONNECTION_FAILED");
}

function assertNever(_value: never): never {
  throw new WebRtcFileTransferError("SIGNALING_INVALID");
}
