import {
  type ProjectUploadKeyId,
  REMOTE_CONTROL_MESSAGE_TYPES,
} from "@jianying/contracts";
import { computed, ref } from "vue";
import { createCameraVideoRecorder } from "@/lib/camera-video-recorder";
import { ConcurrentTaskQueue } from "@/lib/concurrent-task-queue";
import { requestMacControl } from "@/lib/control-room-client";
import {
  exportPublicKeySpkiBase64Url,
  type MobileIdentity,
  MobileUploadState,
  type PairedUploadDestination,
  type ResumableMobileUpload,
} from "@/lib/mobile-state";
import {
  type MobileUploadItem,
  type MobileUploadUpdate,
  mobileUploadErrorDetail,
} from "@/lib/mobile-upload-item";
import {
  browserDisplayName,
  mobileWorkerBaseUrl,
  resumableUploadItem,
} from "@/lib/mobile-upload-presentation";
import {
  executeMobileUploadTransfer,
  type RetryableMobileUpload,
} from "@/lib/mobile-upload-transfer";
import { parseProjectUploadKey } from "@/lib/project-upload-key";

const MAX_CONCURRENT_MOBILE_UPLOADS = 3;

export type {
  MobileUploadItem,
  MobileUploadStatus,
} from "@/lib/mobile-upload-item";

export function useMobileUploader() {
  const activeKeyId = ref<ProjectUploadKeyId>();
  const destinations = ref<readonly PairedUploadDestination[]>([]);
  const initializationMessage = ref("正在准备这台设备的安全身份…");
  const isInitializing = ref(true);
  const isPairing = ref(false);
  const pairingMessage = ref("");
  const cameraMessage = ref("");
  const cameraPreview = ref<MediaStream>();
  const isRecording = ref(false);
  const uploads = ref<readonly MobileUploadItem[]>([]);
  const retryableUploads = new Map<string, RetryableMobileUpload>();
  const transferQueue = new ConcurrentTaskQueue(MAX_CONCURRENT_MOBILE_UPLOADS);
  const cameraRecorder = createCameraVideoRecorder({
    onFailure: (error) => {
      cameraMessage.value = mobileUploadErrorDetail(error);
      cameraPreview.value = undefined;
      isRecording.value = false;
    },
  });
  let state: MobileUploadState | undefined;
  let identity: MobileIdentity | undefined;

  const activeDestination = computed(() =>
    destinations.value.find(
      (destination) => destination.keyId === activeKeyId.value,
    ),
  );
  const canUpload = computed(
    () => !isInitializing.value && activeDestination.value !== undefined,
  );

  async function initialize(): Promise<void> {
    try {
      state = await MobileUploadState.open();
      identity = await state.getOrCreateIdentity();
      destinations.value = await state.listDestinations();
      const persistedKeyId = await state.selectedDestinationKeyId();
      activeKeyId.value = destinations.value.some(
        (destination) => destination.keyId === persistedKeyId,
      )
        ? persistedKeyId
        : destinations.value[0]?.keyId;
      uploads.value = (await state.listResumableUploads()).map((upload) =>
        resumableUploadItem(upload),
      );
      initializationMessage.value = "设备已准备好";
    } catch (error) {
      initializationMessage.value = mobileUploadErrorDetail(error);
    } finally {
      isInitializing.value = false;
    }
  }

  async function selectDestination(keyId: ProjectUploadKeyId): Promise<void> {
    if (state === undefined) {
      return;
    }
    await state.selectDestination(keyId);
    activeKeyId.value = keyId;
  }

  async function pairKey(rawKey: string): Promise<void> {
    if (state === undefined || identity === undefined) {
      pairingMessage.value = "设备安全身份尚未准备好";
      return;
    }
    isPairing.value = true;
    pairingMessage.value = "正在向这台 Mac 确认 Key 对应的目录…";
    try {
      const parsedKey = parseProjectUploadKey(rawKey);
      const response = await requestMacControl({
        nodeId: parsedKey.nodeId,
        request: {
          deviceId: identity.deviceId,
          displayName: browserDisplayName(),
          publicKeySpkiBase64Url: await exportPublicKeySpkiBase64Url(identity),
          rawKey,
          requestId: crypto.randomUUID(),
          type: REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_REQUEST,
        },
        workerBaseUrl: mobileWorkerBaseUrl(),
      });
      if (
        response.type !==
        REMOTE_CONTROL_MESSAGE_TYPES.PROJECT_UPLOAD_KEY_REDEEM_ACCEPTED
      ) {
        pairingMessage.value = "该 Key 已失效、被撤销，或当前 Mac 不在线";
        return;
      }
      const saved = await state.saveDestination({
        directoryName: response.directoryName,
        keyId: response.keyId,
        nodeId: parsedKey.nodeId,
      });
      destinations.value = saved;
      await selectDestination(response.keyId);
      pairingMessage.value = `已配对：${response.directoryName}`;
    } catch (error) {
      pairingMessage.value = mobileUploadErrorDetail(error);
    } finally {
      isPairing.value = false;
    }
  }

  function uploadFiles(files: readonly File[]): void {
    const destination = activeDestination.value;
    if (destination === undefined || identity === undefined) {
      return;
    }
    for (const file of files) {
      enqueueUpload({ destination, file, identity });
    }
  }

  async function startCameraRecording(): Promise<void> {
    if (!canUpload.value) {
      return;
    }
    cameraMessage.value = "正在请求摄像头和麦克风权限…";
    try {
      const capture = await cameraRecorder.start();
      cameraPreview.value = capture.previewStream;
      isRecording.value = true;
      cameraMessage.value = "正在录制；停止后会直接加入当前上传队列。";
    } catch (error) {
      cameraMessage.value = mobileUploadErrorDetail(error);
    }
  }

  async function stopCameraRecording(): Promise<void> {
    try {
      const file = await cameraRecorder.stop();
      cameraPreview.value = undefined;
      isRecording.value = false;
      cameraMessage.value = `已生成 ${file.name}，正在加入上传队列。`;
      uploadFiles([file]);
    } catch (error) {
      cameraMessage.value = mobileUploadErrorDetail(error);
      cameraPreview.value = undefined;
      isRecording.value = false;
    }
  }

  async function resumeFiles(files: readonly File[]): Promise<void> {
    if (state === undefined || identity === undefined) {
      return;
    }
    const pending = await state.listResumableUploads();
    for (const file of files) {
      const resumableCandidates = pending.filter(
        (upload) =>
          upload.fileName === file.name && upload.sizeBytes === file.size,
      );
      const initialCandidate = resumableCandidates[0];
      if (initialCandidate === undefined) {
        continue;
      }
      enqueueUpload({
        destination: initialCandidate,
        file,
        identity,
        resumableCandidates,
      });
    }
  }

  function enqueueUpload(
    input: RetryableMobileUpload,
    existingId?: string,
  ): void {
    const id = existingId ?? crypto.randomUUID();
    retryableUploads.set(id, input);
    const queued: MobileUploadItem = {
      directoryName: input.destination.directoryName,
      fileName: input.file.name,
      id,
      progressBytes: 0,
      sizeBytes: input.file.size,
      status: "queued",
      statusDetail: "已加入并行队列，等待可用直传通道…",
    };
    if (existingId === undefined) {
      appendUpload(queued);
    } else {
      updateUpload(id, queued);
    }
    void transferQueue
      .enqueue(() => uploadOne(input, id))
      .catch((error) => {
        updateUpload(id, {
          status: "failed",
          statusDetail: mobileUploadErrorDetail(error),
        });
      });
  }

  async function uploadOne(
    input: RetryableMobileUpload,
    id: string,
  ): Promise<void> {
    const item: MobileUploadItem = {
      directoryName: input.destination.directoryName,
      fileName: input.file.name,
      id,
      progressBytes: 0,
      sizeBytes: input.file.size,
      status: "hashing",
      statusDetail: "正在计算完整性校验…",
    };
    updateUpload(id, item);
    let resumable: ResumableMobileUpload | undefined;
    try {
      await executeMobileUploadTransfer({
        attempt: input,
        onResumableUpload: async (upload) => {
          resumable = upload;
          removeUploads([upload.uploadId]);
          retryableUploads.set(id, {
            ...input,
            destination: upload,
            resumableCandidates: [upload],
          });
          await state?.saveResumableUpload(upload);
          updateUpload(id, { directoryName: upload.directoryName });
        },
        onUpdate: (patch) => updateUpload(id, patch),
      });
      updateUpload(id, {
        progressBytes: input.file.size,
        status: "completed",
        statusDetail: "已进入对应素材目录",
      });
      retryableUploads.delete(id);
      if (resumable !== undefined) {
        await state?.removeResumableUpload(resumable.uploadId);
      }
    } catch (error) {
      updateUpload(id, {
        status: "failed",
        statusDetail: mobileUploadErrorDetail(error),
      });
    }
  }

  async function retryUpload(id: string): Promise<void> {
    const retryable = retryableUploads.get(id);
    if (retryable === undefined) {
      return;
    }
    enqueueUpload(retryable, id);
  }

  function appendUpload(upload: MobileUploadItem): void {
    uploads.value = [...uploads.value, upload];
  }

  function updateUpload(id: string, patch: MobileUploadUpdate): void {
    uploads.value = uploads.value.map((upload) =>
      upload.id === id ? { ...upload, ...patch } : upload,
    );
  }

  function removeUploads(ids: readonly string[]): void {
    uploads.value = uploads.value.filter((upload) => !ids.includes(upload.id));
  }

  return {
    activeDestination,
    canUpload,
    cameraMessage,
    cameraPreview,
    destinations,
    initialize,
    initializationMessage,
    isInitializing,
    isPairing,
    isRecording,
    pairKey,
    pairingMessage,
    selectDestination,
    startCameraRecording,
    stopCameraRecording,
    retryUpload,
    resumeFiles,
    uploadFiles,
    uploads,
  };
}
