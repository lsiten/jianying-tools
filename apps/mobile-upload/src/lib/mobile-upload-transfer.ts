import {
  REMOTE_CONTROL_MESSAGE_TYPES,
  type RemoteControlMacResponse,
} from "@jianying/contracts";

import { requestMacControl } from "./control-room-client.js";
import { hashFileSha256 } from "./file-sha256.js";
import {
  type MobileIdentity,
  type PairedUploadDestination,
  type ResumableMobileUpload,
  signWithMobileIdentity,
} from "./mobile-state.js";
import type { MobileUploadUpdate } from "./mobile-upload-item.js";
import {
  isWebRtcSessionRefreshable,
  transferFileOverWebRtc,
} from "./webrtc-file-transfer.js";

const HASH_CHUNK_BYTES = 1_048_576;

export type RetryableMobileUpload = {
  readonly destination: PairedUploadDestination;
  readonly file: File;
  readonly identity: MobileIdentity;
  readonly resumableCandidates?: readonly ResumableMobileUpload[];
};

export type MobileUploadTransferDependencies = {
  readonly hashFileSha256: typeof hashFileSha256;
  readonly randomRequestId: () => string;
  readonly requestMacControl: typeof requestMacControl;
  readonly transferFileOverWebRtc: typeof transferFileOverWebRtc;
  readonly workerBaseUrl: () => string;
};

export async function executeMobileUploadTransfer(input: {
  readonly attempt: RetryableMobileUpload;
  readonly onResumableUpload: (upload: ResumableMobileUpload) => Promise<void>;
  readonly onUpdate: (patch: MobileUploadUpdate) => void;
}): Promise<void> {
  return executeMobileUploadTransferWithDependencies(input, {
    hashFileSha256,
    randomRequestId: () => crypto.randomUUID(),
    requestMacControl,
    transferFileOverWebRtc,
    workerBaseUrl,
  });
}

export async function executeMobileUploadTransferWithDependencies(
  input: {
    readonly attempt: RetryableMobileUpload;
    readonly onResumableUpload: (
      upload: ResumableMobileUpload,
    ) => Promise<void>;
    readonly onUpdate: (patch: MobileUploadUpdate) => void;
  },
  dependencies: MobileUploadTransferDependencies,
): Promise<void> {
  const expectedSha256 = await dependencies.hashFileSha256(input.attempt.file, {
    chunkBytes: HASH_CHUNK_BYTES,
    onProgress: (progressBytes) =>
      input.onUpdate({
        progressBytes,
        statusDetail: "正在计算完整性校验…",
      }),
  });
  input.onUpdate({
    progressBytes: 0,
    status: "negotiating",
    statusDetail: "正在建立 Mac 直传会话…",
  });
  const resumed = matchingResumableUpload(
    input.attempt.resumableCandidates,
    expectedSha256,
  );
  const destination = resumed ?? input.attempt.destination;
  const response = await requestTransferSession({
    attempt: input.attempt,
    dependencies,
    destination,
    expectedSha256,
    resumed,
  });
  const resumableUpload: ResumableMobileUpload = {
    directoryName: destination.directoryName,
    expectedSha256,
    fileName: input.attempt.file.name,
    keyId: destination.keyId,
    nodeId: destination.nodeId,
    sizeBytes: input.attempt.file.size,
    uploadId: response.uploadId,
  };
  await input.onResumableUpload(resumableUpload);
  input.onUpdate({
    status: "transferring",
    statusDetail: "手机正在直传至 Mac…",
  });
  try {
    await transferOverWebRtc({
      attempt: input.attempt,
      dependencies,
      response,
      onUpdate: input.onUpdate,
    });
  } catch (error) {
    if (!isWebRtcSessionRefreshable(error)) {
      throw error;
    }
    input.onUpdate({
      status: "negotiating",
      statusDetail: "正在刷新直传会话…",
    });
    const refreshedResponse = await requestTransferSession({
      attempt: input.attempt,
      dependencies,
      destination,
      expectedSha256,
      resumed: resumableUpload,
    });
    input.onUpdate({
      status: "transferring",
      statusDetail: "手机正在直传至 Mac…",
    });
    await transferOverWebRtc({
      attempt: input.attempt,
      dependencies,
      onUpdate: input.onUpdate,
      response: refreshedResponse,
    });
  }
}

class MobileUploadTransferError extends Error {
  readonly name = "MobileUploadTransferError";

  constructor(
    readonly reason:
      | "FILE_DOES_NOT_MATCH"
      | "RESUME_REQUEST_REJECTED"
      | "TRANSFER_REQUEST_REJECTED",
  ) {
    super(`Mobile upload failed: ${reason}`);
  }
}

function matchingResumableUpload(
  candidates: readonly ResumableMobileUpload[] | undefined,
  expectedSha256: string,
): ResumableMobileUpload | undefined {
  if (candidates === undefined) {
    return undefined;
  }
  const matched = candidates.find(
    (candidate) => candidate.expectedSha256 === expectedSha256,
  );
  if (matched === undefined) {
    throw new MobileUploadTransferError("FILE_DOES_NOT_MATCH");
  }
  return matched;
}

type AcceptedTransferResponse = Extract<
  RemoteControlMacResponse,
  {
    readonly type:
      | typeof REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED
      | typeof REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED;
  }
>;

async function requestTransferSession(input: {
  readonly attempt: RetryableMobileUpload;
  readonly dependencies: MobileUploadTransferDependencies;
  readonly destination: PairedUploadDestination;
  readonly expectedSha256: string;
  readonly resumed: ResumableMobileUpload | undefined;
}): Promise<AcceptedTransferResponse> {
  const response = await input.dependencies.requestMacControl({
    nodeId: input.destination.nodeId,
    request:
      input.resumed === undefined
        ? {
            deviceId: input.attempt.identity.deviceId,
            expectedSha256: input.expectedSha256,
            expectedSizeBytes: String(input.attempt.file.size),
            fileName: input.attempt.file.name,
            keyId: input.destination.keyId,
            requestId: input.dependencies.randomRequestId(),
            type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_REQUEST,
          }
        : {
            deviceId: input.attempt.identity.deviceId,
            expectedSha256: input.expectedSha256,
            expectedSizeBytes: String(input.attempt.file.size),
            fileName: input.attempt.file.name,
            keyId: input.destination.keyId,
            requestId: input.dependencies.randomRequestId(),
            type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_REQUEST,
            uploadId: input.resumed.uploadId,
          },
    workerBaseUrl: input.dependencies.workerBaseUrl(),
  });
  if (!isAcceptedTransferResponse(response, input.resumed)) {
    throw new MobileUploadTransferError(
      input.resumed === undefined
        ? "TRANSFER_REQUEST_REJECTED"
        : "RESUME_REQUEST_REJECTED",
    );
  }
  return response;
}

function transferOverWebRtc(input: {
  readonly attempt: RetryableMobileUpload;
  readonly dependencies: MobileUploadTransferDependencies;
  readonly onUpdate: (patch: MobileUploadUpdate) => void;
  readonly response: AcceptedTransferResponse;
}): Promise<void> {
  return input.dependencies.transferFileOverWebRtc({
    deviceId: input.attempt.identity.deviceId,
    file: input.attempt.file,
    iceServers: input.response.iceServers,
    maxChunkBytes: input.response.maxChunkBytes,
    mobileSignalingToken: input.response.mobileSignalingToken,
    onProgress: (progressBytes) => input.onUpdate({ progressBytes }),
    sessionId: input.response.sessionId,
    sign: (payload) => signWithMobileIdentity(input.attempt.identity, payload),
    transferGrant: input.response.transferGrant,
    uploadId: input.response.uploadId,
    workerBaseUrl: input.dependencies.workerBaseUrl(),
  });
}

function isAcceptedTransferResponse(
  response: RemoteControlMacResponse,
  resumed: ResumableMobileUpload | undefined,
): response is Extract<
  RemoteControlMacResponse,
  {
    readonly type:
      | typeof REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED
      | typeof REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED;
  }
> {
  return resumed === undefined
    ? response.type ===
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_CREATE_ACCEPTED
    : response.type ===
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_TRANSFER_RESUME_ACCEPTED;
}

function workerBaseUrl(): string {
  return import.meta.env.VITE_SIGNALING_WORKER_URL || window.location.origin;
}
