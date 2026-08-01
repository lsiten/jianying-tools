<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue's template compiler consumes setup bindings.
import { computed, ref } from "vue";

import type {
  CreatedProjectUploadKey,
  CreateProjectUploadKeyInput,
} from "@/lib/control-plane-api";

export type KeyTargetOption = CreateProjectUploadKeyInput["target"] & {
  readonly categoryName: string;
  readonly projectName: string;
};

export type CreateProjectUploadKeyOutcome =
  | { readonly created: CreatedProjectUploadKey; readonly kind: "created" }
  | { readonly kind: "rejected"; readonly message: string };

const props = defineProps<{
  readonly createKey: (
    input: CreateProjectUploadKeyInput,
  ) => Promise<CreateProjectUploadKeyOutcome>;
  readonly disabled: boolean;
  readonly isSubmitting: boolean;
  readonly targets: readonly KeyTargetOption[];
}>();

const directoryName = ref("");
const feedback = ref("");
const issued = ref<CreatedProjectUploadKey>();
const selectedCategoryId = ref("");

const selectedTarget = computed(() =>
  props.targets.find(
    (target) => target.categoryId === selectedCategoryId.value,
  ),
);

async function submit(): Promise<void> {
  const target = selectedTarget.value;
  const normalizedDirectoryName = directoryName.value.trim();
  if (target === undefined) {
    feedback.value = "请先选择一个项目与素材分类。";
    return;
  }
  if (normalizedDirectoryName.length === 0) {
    feedback.value = "请填写这个 Key 对应的素材目录名。";
    return;
  }
  feedback.value = "";
  issued.value = undefined;
  const outcome = await props.createKey({
    directoryName: normalizedDirectoryName,
    target,
  });
  if (outcome.kind === "rejected") {
    feedback.value = outcome.message;
    return;
  }
  issued.value = outcome.created;
  directoryName.value = "";
  feedback.value = "Key 已生成。复制或在手机端粘贴后即可关闭。";
}

async function copyKey(): Promise<void> {
  if (issued.value === undefined) {
    return;
  }
  try {
    await navigator.clipboard.writeText(issued.value.rawKey);
    feedback.value = "已复制 Key。它不会被桌面端再次保存或展示。";
  } catch (error) {
    feedback.value = "无法自动复制，请手动复制上方 Key。";
  }
}

function dismissKey(): void {
  issued.value = undefined;
  feedback.value =
    "已从当前页面隐藏原始 Key；如未保存，请为该目录重新创建一个 Key。";
}
</script>

<template>
  <section class="status-card" aria-labelledby="upload-key-title">
    <div class="status-card__heading">
      <div>
        <p class="eyebrow">手机配对</p>
        <h2 id="upload-key-title">创建目录专属 Key</h2>
      </div>
    </div>
    <p class="status-card__message">
      一个项目/分类可创建多个 Key；每个 Key 只绑定一个素材目录，手机不能改写这个去向。
    </p>
    <form class="form-stack" @submit.prevent="submit">
      <label class="field-group" for="upload-key-target">
        <span>项目与素材分类</span>
        <select
          id="upload-key-target"
          v-model="selectedCategoryId"
          :disabled="disabled || isSubmitting || targets.length === 0"
          required
        >
          <option disabled value="">请选择素材目标</option>
          <option v-for="target in targets" :key="target.categoryId" :value="target.categoryId">
            {{ target.projectName }} / {{ target.categoryName }}
          </option>
        </select>
      </label>
      <label class="field-group" for="upload-key-directory">
        <span>手机展示的目录名</span>
        <input
          id="upload-key-directory"
          v-model="directoryName"
          :disabled="disabled || isSubmitting"
          placeholder="例如：傍晚散步"
          required
        />
      </label>
      <button
        class="button button--primary"
        :disabled="disabled || isSubmitting || targets.length === 0"
        type="submit"
      >
        {{ isSubmitting ? "正在创建…" : "创建手机配对 Key" }}
      </button>
    </form>
    <div v-if="issued" class="issued-key" aria-label="一次性项目上传 Key">
      <p class="eyebrow">仅展示一次</p>
      <p>目录：{{ issued.uploadKey.directoryName }}</p>
      <textarea aria-label="项目上传 Key" readonly :value="issued.rawKey" />
      <div class="issued-key__actions">
        <button class="button button--secondary" type="button" @click="copyKey">复制 Key</button>
        <button class="button button--secondary" type="button" @click="dismissKey">关闭并隐藏</button>
      </div>
    </div>
    <p v-if="feedback" class="form-feedback" aria-live="polite">{{ feedback }}</p>
  </section>
</template>
