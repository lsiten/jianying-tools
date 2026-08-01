<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue's template compiler consumes setup bindings.
import { ref } from "vue";

import type { CreateProjectTargetOutcome } from "@/composables/use-control-plane";
import type { CreateProjectTargetInput } from "@/lib/control-plane-api";

const props = defineProps<{
  readonly createTarget: (
    input: CreateProjectTargetInput,
  ) => Promise<CreateProjectTargetOutcome>;
  readonly disabled: boolean;
  readonly isSubmitting: boolean;
}>();

const projectName = ref("");
const categoryName = ref("");
const validationMessage = ref("");

async function submit(): Promise<void> {
  const normalizedProject = projectName.value.trim();
  const normalizedCategory = categoryName.value.trim();
  if (normalizedProject.length === 0 || normalizedCategory.length === 0) {
    validationMessage.value = "请填写项目名称和素材分类。";
    return;
  }
  validationMessage.value = "";
  const outcome = await props.createTarget({
    categoryName: normalizedCategory,
    projectName: normalizedProject,
  });
  if (outcome.kind === "rejected") {
    validationMessage.value = outcome.message;
    return;
  }
  projectName.value = "";
  categoryName.value = "";
}
</script>

<template>
  <section class="status-card" aria-labelledby="target-title">
    <div class="status-card__heading">
      <div>
        <p class="eyebrow">素材去向</p>
        <h2 id="target-title">创建项目与分类</h2>
      </div>
    </div>
    <p class="status-card__message">
      手机上传只会进入这里创建的项目/分类，不会让手机直接选择 Mac 文件夹。
    </p>
    <form class="form-stack" @submit.prevent="submit">
      <label class="field-group" for="project-name">
        <span>项目名称</span>
        <input
          id="project-name"
          v-model="projectName"
          :aria-describedby="validationMessage ? 'target-form-feedback' : undefined"
          :aria-invalid="validationMessage.length > 0"
          :disabled="disabled"
          required
        />
      </label>
      <label class="field-group" for="category-name">
        <span>素材分类</span>
        <input
          id="category-name"
          v-model="categoryName"
          :aria-describedby="validationMessage ? 'target-form-feedback' : undefined"
          :aria-invalid="validationMessage.length > 0"
          :disabled="disabled"
          required
        />
      </label>
      <p v-if="validationMessage" id="target-form-feedback" class="field-error" role="alert">
        {{ validationMessage }}
      </p>
      <button class="button button--primary" :disabled="disabled || isSubmitting" type="submit">
        {{ isSubmitting ? "正在创建…" : "创建素材目标" }}
      </button>
    </form>
  </section>
</template>
