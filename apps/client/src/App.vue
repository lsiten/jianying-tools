<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: Vue's template compiler consumes component imports.
// biome-ignore-all lint/correctness/noUnusedVariables: Vue's template compiler consumes setup bindings.
import { onMounted } from "vue";

import ConnectionCard from "@/components/ConnectionCard.vue";
import ProjectTargetForm from "@/components/ProjectTargetForm.vue";
import ProjectUploadKeyForm from "@/components/ProjectUploadKeyForm.vue";
import { useControlPlane } from "@/composables/use-control-plane";
import { useNativeTransferNotice } from "@/composables/use-native-transfer-notice";

const STORAGE_WARNING_BYTES = 10n * 1_024n * 1_024n * 1_024n;

const {
  canCreateTarget,
  canCreateKey,
  connectionState,
  createProjectUploadKey,
  createProjectTarget,
  isCreatingKey,
  isCreatingTarget,
  message,
  refreshHealth,
  serverUrl,
  storageStatus,
  targets,
} = useControlPlane();
const { listenerError, notice } = useNativeTransferNotice();

onMounted(refreshHealth);

function storagePressure(availableBytes: string): "offline" | "online" {
  return BigInt(availableBytes) < STORAGE_WARNING_BYTES ? "offline" : "online";
}

function storagePressureLabel(availableBytes: string): string {
  return storagePressure(availableBytes) === "offline"
    ? "空间紧张"
    : "空间正常";
}

function formatStorageBytes(value: string): string {
  const bytes = BigInt(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let amount = bytes;
  while (amount >= 1_024n && unitIndex < units.length - 1) {
    amount /= 1_024n;
    unitIndex += 1;
  }
  return `${amount} ${units[unitIndex]}`;
}
</script>

<template>
  <div class="app-shell">
    <aside class="app-shell__nav" aria-label="本机智能剪辑导航">
      <div class="brand-block">
        <p class="brand-block__kicker">LOCAL-FIRST STUDIO</p>
        <h1>本机智能剪辑</h1>
        <p>把项目、素材与自动剪辑留在你的 Mac。</p>
      </div>
      <nav class="navigation" aria-label="当前模块">
        <a aria-current="page" href="#overview">工作台</a>
        <a href="#targets">素材目标</a>
        <a href="#upload-keys">配对 Key</a>
        <a href="#storage">本机容量</a>
        <a href="#transfer-policy">公网传输</a>
      </nav>
      <p class="nav-note">
        公网只用于加密信令。素材字节不会经由 Cloudflare Workers 传输或落盘。
      </p>
    </aside>

    <main class="app-shell__main" id="overview">
      <header class="page-header">
        <div>
          <p class="eyebrow">工作台</p>
          <h2>先建立素材去向，<span class="heading-phrase">再开始手机传输。</span></h2>
        </div>
        <p class="page-header__status" :data-state="connectionState">
          {{ connectionState === "online" ? "Mac 本机在线" : "等待本机服务" }}
        </p>
      </header>

      <div class="dashboard-grid">
        <ConnectionCard
          v-model:server-url="serverUrl"
          :message="message"
          :state="connectionState"
          @refresh="refreshHealth"
        />
        <ProjectTargetForm
          id="targets"
          :create-target="createProjectTarget"
          :disabled="!canCreateTarget"
          :is-submitting="isCreatingTarget"
        />
        <ProjectUploadKeyForm
          id="upload-keys"
          :create-key="createProjectUploadKey"
          :disabled="!canCreateKey"
          :is-submitting="isCreatingKey"
          :targets="targets"
        />
      </div>

      <section class="transfer-policy" id="transfer-policy" aria-labelledby="transfer-policy-title">
        <div>
          <p class="eyebrow">公网传输策略</p>
          <h2 id="transfer-policy-title">优先直连；受限网络自动使用已配置的 TURN。</h2>
        </div>
        <div class="transfer-policy__details">
          <p>
            手机与这台 Mac 通过 WebRTC DataChannel 传输素材。Cloudflare Workers + Durable Object
            只交换加密信令与在线状态；只有在点对点不可达时，才通过已配置的 Cloudflare TURN 中继。
          </p>
          <p>
            TURN 长期密钥只保存在这台 Mac。每次上传会话向 Cloudflare 换取短期凭据，并同时配置给 Mac 与手机；
            素材不会经过 Workers 落盘。
          </p>
        </div>
      </section>

      <section
        v-if="notice || listenerError"
        class="transfer-alert"
        :data-kind="notice?.kind"
        role="alert"
      >
        <div v-if="notice">
          <p class="eyebrow">传输状态</p>
          <h2>{{ notice.title }}</h2>
          <p>{{ notice.detail }}</p>
        </div>
        <div v-else>
          <p class="eyebrow">传输状态</p>
          <h2>本机传输状态不可用</h2>
          <p>{{ listenerError }}</p>
        </div>
      </section>

      <section class="targets-list" aria-labelledby="created-targets-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">本次会话</p>
            <h2 id="created-targets-title">已创建的素材目标</h2>
          </div>
          <p>{{ targets.length }} 个</p>
        </div>
        <ul v-if="targets.length > 0" class="target-list">
          <li v-for="target in targets" :key="target.categoryId">
            <strong>{{ target.projectName }} / {{ target.categoryName }}</strong>
            <span>项目 {{ target.projectId }}</span>
            <code>分类 {{ target.categoryId }}</code>
          </li>
        </ul>
        <p v-else class="empty-state">尚未创建素材目标。先建立一个项目与分类，手机上传才能拥有明确去向。</p>
      </section>

      <section class="targets-list" id="storage" aria-labelledby="storage-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">素材磁盘</p>
            <h2 id="storage-title">本机容量</h2>
          </div>
          <span v-if="storageStatus" class="status-badge" :data-state="storagePressure(storageStatus.availableBytes)">
            {{ storagePressureLabel(storageStatus.availableBytes) }}
          </span>
        </div>
        <template v-if="storageStatus">
          <p class="storage-summary">可用 {{ formatStorageBytes(storageStatus.availableBytes) }} · 正在为未完成上传预留 {{ formatStorageBytes(storageStatus.reservedBytes) }}</p>
          <p v-if="storagePressure(storageStatus.availableBytes) === 'offline'" class="field-error">可用空间低于 10 GB。请更换素材目录到容量更大的硬盘，或先释放本机空间。</p>
        </template>
        <p v-else class="empty-state">连接本机服务后显示当前素材目录所在硬盘的可用容量。</p>
      </section>
    </main>
  </div>
</template>
