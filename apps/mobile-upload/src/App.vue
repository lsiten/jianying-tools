<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue's template compiler consumes setup bindings.
import { computed, nextTick, onMounted, ref, watch } from "vue";

import { useMobileUploader } from "@/composables/use-mobile-uploader";
import {
  formatUploadBytes,
  uploadStatusLabel,
} from "@/lib/mobile-upload-display";

const keyInput = ref("");
const fileInput = ref<HTMLInputElement>();
const resumeFileInput = ref<HTMLInputElement>();
const cameraPreviewVideo = ref<HTMLVideoElement>();
const uploadFormat = {
  bytes: formatUploadBytes,
  status: uploadStatusLabel,
};
const {
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
  retryUpload,
  resumeFiles,
  selectDestination,
  startCameraRecording,
  stopCameraRecording,
  uploadFiles,
  uploads,
} = useMobileUploader();

const destinationSummary = computed(() => {
  const destination = activeDestination.value;
  return destination === undefined
    ? "先连接一个上传目录，再从手机选择素材或直接录制。"
    : "选择素材或直接录制，都会传到当前目录。";
});

onMounted(initialize);

watch(cameraPreview, async (stream) => {
  await nextTick();
  if (cameraPreviewVideo.value !== undefined) {
    cameraPreviewVideo.value.srcObject = stream ?? null;
  }
});

async function submitPairing(): Promise<void> {
  const rawKey = keyInput.value;
  keyInput.value = "";
  await pairKey(rawKey);
}

function selectFiles(event: Event): void {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || input.files === null) {
    return;
  }
  uploadFiles([...input.files]);
  input.value = "";
}

function openFilePicker(): void {
  fileInput.value?.click();
}

async function selectFilesToResume(event: Event): Promise<void> {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || input.files === null) {
    return;
  }
  await resumeFiles([...input.files]);
  input.value = "";
}

function openResumeFilePicker(): void {
  resumeFileInput.value?.click();
}

async function changeDestination(event: Event): Promise<void> {
  const select = event.currentTarget;
  if (select instanceof HTMLSelectElement) {
    const destination = destinations.value.find(
      (candidate) => candidate.keyId === select.value,
    );
    if (destination !== undefined) {
      await selectDestination(destination.keyId);
    }
  }
}
</script>

<template>
  <main class="mobile-upload-shell">
    <header class="mobile-upload-shell__header">
      <div class="mobile-upload-shell__eyebrow-row">
        <p class="eyebrow">素材直传</p>
        <span class="status-pill" :data-state="canUpload ? 'ready' : 'empty'">
          {{ canUpload ? "已配对" : "等待配对" }}
        </span>
      </div>
      <h1>上传到电脑</h1>
      <p class="mobile-upload-shell__summary">{{ destinationSummary }}</p>
    </header>

    <section v-if="isInitializing" class="transfer-notice" aria-live="polite">
      {{ initializationMessage }}
    </section>

    <section v-else-if="destinations.length === 0" class="pairing-onboarding" aria-labelledby="pairing-title">
      <p class="eyebrow">首次使用</p>
      <h2 id="pairing-title">连接一个上传目录</h2>
      <p>在桌面端生成 Key，粘贴到这里。之后只需要选择素材或直接录制。</p>
      <form class="pairing-form" @submit.prevent="submitPairing">
        <label class="field-group" for="upload-key">
          <span>桌面端上传 Key</span>
          <input
            id="upload-key"
            v-model="keyInput"
            autocomplete="off"
            :disabled="isPairing"
            inputmode="text"
            placeholder="粘贴 jyup1.…"
            spellcheck="false"
          />
        </label>
        <button class="action-button action-button--primary" :disabled="isPairing || keyInput.trim().length === 0" type="submit">
          {{ isPairing ? "正在连接…" : "连接上传目录" }}
        </button>
      </form>
      <p class="inline-message" aria-live="polite">{{ pairingMessage || "Key 仅用于本次连接，不会在手机再次展示。" }}</p>
    </section>

    <template v-else>
      <section class="upload-launchpad" aria-labelledby="upload-launchpad-title">
        <h2 id="upload-launchpad-title" class="visually-hidden">选择上传方式</h2>
        <div class="upload-destination">
          <div>
            <p class="eyebrow">当前上传目录</p>
            <strong>{{ activeDestination?.directoryName }}</strong>
          </div>
          <label v-if="destinations.length > 1" class="directory-switcher">
            <span>切换</span>
            <select :value="activeDestination?.keyId" @change="changeDestination">
              <option v-for="destination in destinations" :key="destination.keyId" :value="destination.keyId">
                {{ destination.directoryName }}
              </option>
            </select>
          </label>
          <span v-else class="directory-current">当前目录</span>
        </div>
        <input aria-hidden="true" ref="fileInput" class="visually-hidden" multiple tabindex="-1" type="file" @change="selectFiles" />
        <div class="upload-actions">
          <button class="upload-action upload-action--file" :disabled="!canUpload" type="button" @click="openFilePicker">
            <span class="upload-action__title">从手机选择</span>
            <span class="upload-action__hint">照片、视频或多个文件</span>
          </button>
          <button
            class="upload-action upload-action--record"
            :data-recording="isRecording"
            :disabled="!canUpload && !isRecording"
            type="button"
            @click="isRecording ? stopCameraRecording() : startCameraRecording()"
          >
            <span class="upload-action__title">{{ isRecording ? "停止并上传" : "现在录制" }}</span>
            <span class="upload-action__hint">{{ isRecording ? "录制结束后自动进入队列" : "调用摄像头，录好自动上传" }}</span>
          </button>
        </div>
        <video
          v-if="cameraPreview !== undefined"
          ref="cameraPreviewVideo"
          autoplay
          class="camera-preview"
          muted
          playsinline
        />
        <p v-if="cameraMessage" class="inline-message" aria-live="polite">{{ cameraMessage }}</p>
      </section>

      <section v-if="uploads.length > 0" class="upload-list" aria-labelledby="upload-list-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">本次传输</p>
            <h2 id="upload-list-title">上传队列</h2>
          </div>
          <span>{{ uploads.length }} 个</span>
        </div>
        <ol class="upload-items">
          <li v-for="upload in uploads" :key="upload.id" class="upload-item" :data-state="upload.status">
            <div class="upload-item__headline">
              <strong>{{ upload.fileName }}</strong>
              <span>{{ uploadFormat.status(upload.status) }}</span>
            </div>
            <p>{{ upload.directoryName }} · {{ uploadFormat.bytes(upload.sizeBytes) }}</p>
            <progress :max="upload.sizeBytes" :value="upload.progressBytes">{{ upload.progressBytes }}</progress>
            <small>{{ upload.statusDetail }}</small>
            <button
              v-if="upload.status === 'failed'"
              class="action-button action-button--secondary"
              type="button"
              @click="retryUpload(upload.id)"
            >
              重试此文件
            </button>
          </li>
        </ol>
        <input aria-hidden="true" ref="resumeFileInput" class="visually-hidden" multiple tabindex="-1" type="file" @change="selectFilesToResume" />
        <button
          v-if="uploads.some((upload) => upload.status === 'awaiting_file')"
          class="action-button action-button--secondary"
          type="button"
          @click="openResumeFilePicker"
        >
          选择原文件续传
        </button>
      </section>
    </template>

    <section v-if="!isInitializing && destinations.length > 0" class="destination-management" aria-labelledby="destination-title">
      <details>
        <summary id="destination-title">添加另一个上传目录</summary>
        <p class="inline-message">新目录只会用于之后加入的文件。</p>
        <form class="pairing-form" @submit.prevent="submitPairing">
          <label class="field-group" for="upload-key">
            <span>添加桌面端生成的上传 Key</span>
            <input
              id="upload-key"
              v-model="keyInput"
              autocomplete="off"
              :disabled="isPairing || isInitializing"
              inputmode="text"
              placeholder="粘贴 jyup1.…"
              spellcheck="false"
            />
          </label>
          <button class="action-button action-button--secondary" :disabled="isPairing || isInitializing || keyInput.trim().length === 0" type="submit">
            {{ isPairing ? "正在确认…" : "添加 Key" }}
          </button>
        </form>
        <p class="inline-message" aria-live="polite">{{ pairingMessage || "Key 不会在手机保存或再次展示。" }}</p>
      </details>
    </section>
  </main>
</template>
