import {
  type DeviceId,
  encodeDataChunkPacket,
  type IceServerDescriptor,
  type UploadId,
  type WebRtcSessionId,
} from "@jianying/contracts";

import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";

export const DATA_CHANNEL_OPEN_TIMEOUT_MS = 30_000;

export type DataChannelOpenTarget = Pick<
  RTCDataChannel,
  "onerror" | "onopen" | "readyState"
>;

export type DataChannelOpenOptions = {
  readonly failureSignal?: AbortSignal;
};

export async function encodeTransferChunk(input: {
  readonly chunkIndex: bigint;
  readonly offsetBytes: bigint;
  readonly payload: Uint8Array;
}): Promise<ArrayBuffer> {
  const checksum = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(input.payload)),
  );
  const frame = encodeDataChunkPacket({
    checksumSha256: bytesToHex(checksum),
    chunkIndex: input.chunkIndex,
    offsetBytes: input.offsetBytes,
    payload: input.payload,
  });
  return Uint8Array.from(frame).buffer;
}

export function createDeviceAuthorizationPayload(input: {
  readonly deviceId: DeviceId;
  readonly dtlsFingerprint: string;
  readonly grant: string;
  readonly sessionId: WebRtcSessionId;
  readonly uploadId: UploadId;
}): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(
    [
      "jianying-transfer-authorize-v1",
      input.deviceId,
      input.sessionId,
      input.uploadId,
      input.grant,
      input.dtlsFingerprint,
    ]
      .map((value) => `${encoder.encode(value).byteLength}:${value}`)
      .join("|"),
  );
}

export function fingerprintFromSdp(sdp: string): string {
  const match = /a=fingerprint:sha-256 ([A-Fa-f0-9:]{95})/.exec(sdp);
  if (match?.[1] === undefined) {
    throw new WebRtcFileTransferError("DTLS_FINGERPRINT_UNAVAILABLE");
  }
  return match[1];
}

export function assertIceServers(
  iceServers: readonly IceServerDescriptor[],
): void {
  if (iceServers.length === 0) {
    throw new WebRtcFileTransferError("SIGNALING_INVALID");
  }
}

export function waitForDataChannelOpen(
  channel: DataChannelOpenTarget,
  options: DataChannelOpenOptions = {},
): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  if (options.failureSignal?.aborted === true) {
    return Promise.reject(new WebRtcFileTransferError("CONNECTION_FAILED"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        settle(() => reject(new WebRtcFileTransferError("CONNECTION_FAILED"))),
      DATA_CHANNEL_OPEN_TIMEOUT_MS,
    );
    const settle = (complete: () => void): void => {
      clearTimeout(timeout);
      channel.onopen = null;
      channel.onerror = null;
      options.failureSignal?.removeEventListener("abort", onPeerFailure);
      complete();
    };
    const onPeerFailure = () =>
      settle(() => reject(new WebRtcFileTransferError("CONNECTION_FAILED")));
    options.failureSignal?.addEventListener("abort", onPeerFailure, {
      once: true,
    });
    channel.onopen = () => settle(resolve);
    channel.onerror = () =>
      settle(() => reject(new WebRtcFileTransferError("CONNECTION_FAILED")));
  });
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}
