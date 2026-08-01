import {
  type DeviceId,
  type IceServerDescriptor,
  SIGNALING_MESSAGE_TYPES,
  type SignalingMessage,
  TRANSFER_CONTROL_MESSAGE_TYPES,
  type UploadId,
  type WebRtcSessionId,
} from "@jianying/contracts";

import {
  TransferControlInbox,
  TransferControlInboxError,
} from "./transfer-control-inbox.js";
import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";
import { createResumeTransferPosition } from "./webrtc-resume-position.js";
import { openMobileSignalingClient } from "./webrtc-signaling-client.js";
import {
  assertIceServers,
  createDeviceAuthorizationPayload,
  encodeTransferChunk,
  fingerprintFromSdp,
  waitForDataChannelOpen,
} from "./webrtc-transfer-protocol.js";

export {
  isWebRtcSessionRefreshable,
  WebRtcFileTransferError,
} from "./webrtc-file-transfer-error.js";

export async function transferFileOverWebRtc(input: {
  readonly deviceId: DeviceId;
  readonly file: File;
  readonly iceServers: readonly IceServerDescriptor[];
  readonly maxChunkBytes: number;
  readonly mobileSignalingToken: string;
  readonly onProgress: (transferredBytes: number) => void;
  readonly sessionId: WebRtcSessionId;
  readonly sign: (payload: Uint8Array) => Promise<string>;
  readonly transferGrant: string;
  readonly uploadId: UploadId;
  readonly workerBaseUrl: string;
}): Promise<void> {
  assertIceServers(input.iceServers);
  const peer = new RTCPeerConnection({
    iceServers: input.iceServers.map((server) => ({
      ...(server.credential === undefined
        ? {}
        : { credential: server.credential }),
      urls: [...server.urls],
      ...(server.username === undefined ? {} : { username: server.username }),
    })),
  });
  const control = peer.createDataChannel(`transfer-control/${input.uploadId}`);
  const data = peer.createDataChannel(`transfer-data/${input.uploadId}`, {
    ordered: true,
  });
  data.binaryType = "arraybuffer";
  const inbox = new TransferControlInbox();
  const directConnection = new AbortController();
  control.onmessage = (event) => inbox.receive(event.data);
  const signaling = openMobileSignalingClient({
    inbox,
    peer,
    sessionId: input.sessionId,
    token: input.mobileSignalingToken,
    workerBaseUrl: input.workerBaseUrl,
  });
  try {
    await signaling.opened;
    peer.onicecandidate = (event) =>
      forwardCandidate(signaling.send, input.sessionId, event);
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") {
        directConnection.abort();
        inbox.reject(new WebRtcFileTransferError("CONNECTION_FAILED"));
      }
    };
    const offerSdp = await createOfferSdp(peer);
    signaling.send({
      descriptionType: "offer",
      sdp: offerSdp,
      sessionId: input.sessionId,
      type: SIGNALING_MESSAGE_TYPES.DESCRIPTION,
    });
    await waitForDataChannelOpen(control, {
      failureSignal: directConnection.signal,
    });
    await waitForDataChannelOpen(data, {
      failureSignal: directConnection.signal,
    });
    const receivedBytes = await authorize(
      input,
      control,
      inbox,
      fingerprintFromSdp(offerSdp),
    );
    await transferChunks({
      control,
      data,
      file: input.file,
      inbox,
      receivedBytes,
      transfer: input,
    });
    control.send(
      JSON.stringify({
        type: TRANSFER_CONTROL_MESSAGE_TYPES.COMPLETE,
        uploadId: input.uploadId,
      }),
    );
    await expectReady(inbox, input.uploadId);
  } catch (error) {
    if (error instanceof WebRtcFileTransferError) {
      throw error;
    }
    if (error instanceof TransferControlInboxError) {
      throw new WebRtcFileTransferError("CONTROL_REJECTED");
    }
    throw new WebRtcFileTransferError("CONNECTION_FAILED");
  } finally {
    signaling.close();
    control.close();
    data.close();
    peer.close();
  }
}

async function createOfferSdp(peer: RTCPeerConnection): Promise<string> {
  const offer = await peer.createOffer();
  if (offer.sdp === undefined) {
    throw new WebRtcFileTransferError("SIGNALING_INVALID");
  }
  await peer.setLocalDescription(offer);
  return offer.sdp;
}

async function authorize(
  input: Parameters<typeof transferFileOverWebRtc>[0],
  control: RTCDataChannel,
  inbox: TransferControlInbox,
  dtlsFingerprint: string,
): Promise<number> {
  control.send(
    JSON.stringify({
      deviceId: input.deviceId,
      deviceProof: await input.sign(
        createDeviceAuthorizationPayload({
          deviceId: input.deviceId,
          dtlsFingerprint,
          grant: input.transferGrant,
          sessionId: input.sessionId,
          uploadId: input.uploadId,
        }),
      ),
      dtlsFingerprint,
      grant: input.transferGrant,
      type: TRANSFER_CONTROL_MESSAGE_TYPES.AUTHORIZE,
      uploadId: input.uploadId,
    }),
  );
  return expectAcknowledgement(inbox, input.uploadId);
}

async function transferChunks(input: {
  readonly control: RTCDataChannel;
  readonly data: RTCDataChannel;
  readonly file: File;
  readonly inbox: TransferControlInbox;
  readonly receivedBytes: number;
  readonly transfer: Parameters<typeof transferFileOverWebRtc>[0];
}): Promise<void> {
  if (input.file.size === 0) {
    throw new WebRtcFileTransferError("CONTROL_REJECTED");
  }
  const position = createResumeTransferPosition({
    fileSize: input.file.size,
    maxChunkBytes: input.transfer.maxChunkBytes,
    receivedBytes: input.receivedBytes,
  });
  input.transfer.onProgress(position.offsetBytes);
  let chunkIndex = position.chunkIndex;
  for (
    let offset = position.offsetBytes;
    offset < input.file.size;
    offset += input.transfer.maxChunkBytes
  ) {
    const payload = new Uint8Array(
      await input.file
        .slice(offset, offset + input.transfer.maxChunkBytes)
        .arrayBuffer(),
    );
    input.data.send(
      await encodeTransferChunk({
        chunkIndex,
        offsetBytes: BigInt(offset),
        payload,
      }),
    );
    await expectAcknowledgement(
      input.inbox,
      input.transfer.uploadId,
      offset + payload.byteLength,
    );
    input.transfer.onProgress(offset + payload.byteLength);
    chunkIndex += 1n;
  }
}

async function expectAcknowledgement(
  inbox: TransferControlInbox,
  uploadId: UploadId,
  expectedBytes?: number,
): Promise<number> {
  const message = await inbox.waitFor(
    uploadId,
    (candidate) =>
      candidate.type === TRANSFER_CONTROL_MESSAGE_TYPES.ACK ||
      candidate.type === TRANSFER_CONTROL_MESSAGE_TYPES.NACK,
  );
  if (message.type !== TRANSFER_CONTROL_MESSAGE_TYPES.ACK) {
    throw new WebRtcFileTransferError("CONTROL_REJECTED");
  }
  const receivedBytes = Number(message.receivedBytes);
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0) {
    throw new WebRtcFileTransferError("CONTROL_REJECTED");
  }
  if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
    throw new WebRtcFileTransferError("CONTROL_REJECTED");
  }
  return receivedBytes;
}

async function expectReady(
  inbox: TransferControlInbox,
  uploadId: UploadId,
): Promise<void> {
  const message = await inbox.waitFor(
    uploadId,
    (candidate) =>
      candidate.type === TRANSFER_CONTROL_MESSAGE_TYPES.READY ||
      candidate.type === TRANSFER_CONTROL_MESSAGE_TYPES.NACK,
  );
  if (message.type !== TRANSFER_CONTROL_MESSAGE_TYPES.READY) {
    throw new WebRtcFileTransferError("CONTROL_REJECTED");
  }
}

function forwardCandidate(
  send: (message: SignalingMessage) => void,
  sessionId: WebRtcSessionId,
  event: RTCPeerConnectionIceEvent,
): void {
  const candidate = event.candidate;
  if (candidate?.candidate !== undefined && candidate.sdpMid !== null) {
    send({
      candidate: candidate.candidate,
      mid: candidate.sdpMid,
      sessionId,
      type: SIGNALING_MESSAGE_TYPES.CANDIDATE,
    });
  }
}
