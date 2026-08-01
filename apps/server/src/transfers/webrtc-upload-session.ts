import {
  DATA_CHUNK_HEADER_BYTES,
  type IceServerDescriptor,
  type TransferControlMessage,
  type UploadId,
} from "@jianying/contracts";
import nodeDataChannel, {
  type DataChannel,
  type DescriptionType,
  type RtcConfig,
} from "node-datachannel";

import type { MaterialLibrary } from "../uploads/material-library.js";
import {
  createIncomingUploadReceiver,
  type IncomingUploadReceiver,
  type TransferAuthorization,
} from "./incoming-upload-receiver.js";
import { createDtlsBoundAuthorization } from "./webrtc-dtls-authorization.js";

export const WEBRTC_UPLOAD_CHANNELS = {
  control: (uploadId: UploadId) => `transfer-control/${uploadId}`,
  data: (uploadId: UploadId) => `transfer-data/${uploadId}`,
} as const;

export const WEBRTC_UPLOAD_SESSION_ERROR_REASONS = {
  CHUNK_MEMORY_LIMIT_EXCEEDED: "CHUNK_MEMORY_LIMIT_EXCEEDED",
  CONTROL_CHANNEL_REQUIRED: "CONTROL_CHANNEL_REQUIRED",
  CONTROL_SEND_FAILED: "CONTROL_SEND_FAILED",
  INVALID_CHUNK_MEMORY_LIMIT: "INVALID_CHUNK_MEMORY_LIMIT",
  INVALID_ICE_SERVER: "INVALID_ICE_SERVER",
  UNEXPECTED_CHANNEL: "UNEXPECTED_CHANNEL",
} as const;

export type WebRtcUploadSessionErrorReason =
  (typeof WEBRTC_UPLOAD_SESSION_ERROR_REASONS)[keyof typeof WEBRTC_UPLOAD_SESSION_ERROR_REASONS];

export class WebRtcUploadSessionError extends Error {
  readonly name = "WebRtcUploadSessionError";

  constructor(readonly reason: WebRtcUploadSessionErrorReason) {
    super(`WebRTC upload session failed: ${reason}`);
  }
}

export type WebRtcUploadSignal =
  | {
      readonly candidate: string;
      readonly kind: "candidate";
      readonly mid: string;
    }
  | {
      readonly descriptionType: DescriptionType;
      readonly kind: "description";
      readonly sdp: string;
    }
  | { readonly kind: "state"; readonly state: string };

export interface WebRtcUploadSession {
  acceptRemoteCandidate(input: {
    readonly candidate: string;
    readonly mid: string;
  }): void;
  acceptRemoteDescription(input: {
    readonly descriptionType: DescriptionType;
    readonly sdp: string;
  }): void;
  close(): void;
}

export function createWebRtcUploadSession(input: {
  readonly authorize?: TransferAuthorization;
  readonly iceServers: readonly IceServerDescriptor[];
  readonly materialLibrary: MaterialLibrary;
  readonly maxChunkBytes: number;
  readonly onError?: (error: Error) => void;
  readonly onSignal: (signal: WebRtcUploadSignal) => void;
  readonly uploadId: UploadId;
}): WebRtcUploadSession {
  if (!Number.isSafeInteger(input.maxChunkBytes) || input.maxChunkBytes < 1) {
    throw new WebRtcUploadSessionError("INVALID_CHUNK_MEMORY_LIMIT");
  }
  return new NodeDataChannelUploadSession({
    ...input,
    onError: input.onError ?? (() => undefined),
  });
}

/** Converts the shared browser descriptor into node-datachannel's relay-specific format. */
export function toNodeDataChannelIceServers(
  iceServers: readonly IceServerDescriptor[],
): RtcConfig["iceServers"] {
  return iceServers.flatMap((server) =>
    server.urls.map((url) => toNodeDataChannelIceServer(url, server)),
  );
}

function toNodeDataChannelIceServer(
  url: string,
  server: IceServerDescriptor,
): NonNullable<RtcConfig["iceServers"]>[number] {
  if (/^stun:/i.test(url)) {
    return url;
  }
  if (
    !/^turns?:/i.test(url) ||
    server.username === undefined ||
    server.credential === undefined
  ) {
    throw new WebRtcUploadSessionError("INVALID_ICE_SERVER");
  }
  const relayType = url.startsWith("turns:")
    ? "TurnTls"
    : new URL(url.replace(/^turn:/i, "http://")).searchParams.get(
          "transport",
        ) === "udp"
      ? "TurnUdp"
      : "TurnTcp";
  let endpoint: URL;
  try {
    endpoint = new URL(url.replace(/^turns?:/i, "http://"));
  } catch {
    throw new WebRtcUploadSessionError("INVALID_ICE_SERVER");
  }
  if (endpoint.hostname.length === 0) {
    throw new WebRtcUploadSessionError("INVALID_ICE_SERVER");
  }
  const port =
    endpoint.port.length === 0
      ? relayType === "TurnTls"
        ? 5349
        : 3478
      : Number(endpoint.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new WebRtcUploadSessionError("INVALID_ICE_SERVER");
  }
  return {
    hostname: endpoint.hostname,
    password: server.credential,
    port,
    relayType,
    username: server.username,
  };
}

class NodeDataChannelUploadSession implements WebRtcUploadSession {
  private controlChannel: DataChannel | undefined;
  private dataChannel: DataChannel | undefined;
  private pendingDataChannel: DataChannel | undefined;
  private readonly receiver: IncomingUploadReceiver;
  private readonly workQueue: IncomingMessageQueue;

  constructor(
    private readonly input: {
      readonly authorize?: TransferAuthorization;
      readonly iceServers: readonly IceServerDescriptor[];
      readonly materialLibrary: MaterialLibrary;
      readonly maxChunkBytes: number;
      readonly onError: (error: Error) => void;
      readonly onSignal: (signal: WebRtcUploadSignal) => void;
      readonly uploadId: UploadId;
    },
  ) {
    this.workQueue = new IncomingMessageQueue(input.onError);
    this.peer = new nodeDataChannel.PeerConnection(`upload-${input.uploadId}`, {
      iceServers: toNodeDataChannelIceServers(input.iceServers),
      maxMessageSize: input.maxChunkBytes + DATA_CHUNK_HEADER_BYTES,
    });
    this.receiver = createIncomingUploadReceiver({
      authorize: createDtlsBoundAuthorization({
        ...(input.authorize === undefined
          ? {}
          : { authorize: input.authorize }),
        peer: this.peer,
      }),
      materialLibrary: input.materialLibrary,
      uploadId: input.uploadId,
    });
    this.peer.onLocalDescription((sdp, descriptionType) => {
      input.onSignal({ descriptionType, kind: "description", sdp });
    });
    this.peer.onLocalCandidate((candidate, mid) => {
      input.onSignal({ candidate, kind: "candidate", mid });
    });
    this.peer.onStateChange((state) => {
      input.onSignal({ kind: "state", state });
    });
    this.peer.onDataChannel((channel) => this.attachChannel(channel));
  }

  private readonly peer: InstanceType<typeof nodeDataChannel.PeerConnection>;

  acceptRemoteCandidate(input: {
    readonly candidate: string;
    readonly mid: string;
  }): void {
    this.peer.addRemoteCandidate(input.candidate, input.mid);
  }

  acceptRemoteDescription(input: {
    readonly descriptionType: DescriptionType;
    readonly sdp: string;
  }): void {
    this.peer.setRemoteDescription(input.sdp, input.descriptionType);
  }

  close(): void {
    this.controlChannel?.close();
    this.dataChannel?.close();
    this.peer.close();
  }

  private attachChannel(channel: DataChannel): void {
    if (
      channel.getLabel() === WEBRTC_UPLOAD_CHANNELS.control(this.input.uploadId)
    ) {
      this.attachControlChannel(channel);
      return;
    }
    if (
      channel.getLabel() === WEBRTC_UPLOAD_CHANNELS.data(this.input.uploadId)
    ) {
      this.attachDataChannel(channel);
      return;
    }
    channel.close();
    this.input.onError(new WebRtcUploadSessionError("UNEXPECTED_CHANNEL"));
  }

  private attachControlChannel(channel: DataChannel): void {
    if (this.controlChannel !== undefined) {
      channel.close();
      this.input.onError(new WebRtcUploadSessionError("UNEXPECTED_CHANNEL"));
      return;
    }
    this.controlChannel = channel;
    if (this.pendingDataChannel !== undefined) {
      this.bindDataChannel(this.pendingDataChannel);
      this.pendingDataChannel = undefined;
    }
    channel.onMessage((message) => {
      if (typeof message !== "string") {
        this.sendControl(this.nack("CONTROL_JSON_INVALID"));
        return;
      }
      this.workQueue.enqueue(async () => {
        this.sendControl(await this.receiver.receiveControl(message));
      });
    });
  }

  private attachDataChannel(channel: DataChannel): void {
    if (this.controlChannel === undefined) {
      if (this.pendingDataChannel === undefined) {
        this.pendingDataChannel = channel;
        return;
      }
      channel.close();
      this.input.onError(new WebRtcUploadSessionError("UNEXPECTED_CHANNEL"));
      return;
    }
    this.bindDataChannel(channel);
  }

  private bindDataChannel(channel: DataChannel): void {
    if (this.dataChannel !== undefined) {
      channel.close();
      this.input.onError(new WebRtcUploadSessionError("UNEXPECTED_CHANNEL"));
      return;
    }
    this.dataChannel = channel;
    channel.onMessage((message) => {
      const bytes = toBytes(message);
      if (bytes === undefined) {
        this.sendControl(this.nack("BINARY_PACKET_REQUIRED"));
        return;
      }
      if (
        bytes.byteLength >
        this.input.maxChunkBytes + DATA_CHUNK_HEADER_BYTES
      ) {
        this.sendControl(this.nack("CHUNK_MEMORY_LIMIT_EXCEEDED"));
        return;
      }
      this.workQueue.enqueue(async () => {
        this.sendControl(await this.receiver.receiveData(bytes));
      });
    });
  }

  private nack(code: string): TransferControlMessage {
    return { code, type: "nack", uploadId: this.input.uploadId };
  }

  private sendControl(message: TransferControlMessage): void {
    if (this.controlChannel?.sendMessage(JSON.stringify(message)) !== true) {
      this.input.onError(new WebRtcUploadSessionError("CONTROL_SEND_FAILED"));
    }
  }
}

class IncomingMessageQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (error: Error) => void) {}

  enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(work, work).catch((error: unknown) => {
      if (error instanceof Error) {
        this.onError(error);
        return;
      }
      this.onError(new WebRtcUploadSessionError("UNEXPECTED_CHANNEL"));
    });
  }
}

function toBytes(
  message: string | Buffer | ArrayBuffer,
): Uint8Array | undefined {
  if (message instanceof Uint8Array) {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  return undefined;
}
