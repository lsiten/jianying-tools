<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue's template compiler consumes setup bindings.
defineProps<{
  readonly message: string;
  readonly serverUrl: string;
  readonly state: "checking" | "offline" | "online";
}>();

const emit = defineEmits<{
  refresh: [];
  "update:serverUrl": [value: string];
}>();

const stateLabel = {
  checking: "检查中",
  offline: "未连接",
  online: "本机在线",
} as const;

function updateServerUrl(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    emit("update:serverUrl", target.value);
  }
}
</script>

<template>
  <section class="status-card" aria-labelledby="connection-title">
    <div class="status-card__heading">
      <div>
        <p class="eyebrow">本机控制面</p>
        <h2 id="connection-title">Mac 服务状态</h2>
      </div>
      <p class="status-badge" :data-state="state">{{ stateLabel[state] }}</p>
    </div>
    <p class="status-card__message" aria-live="polite">{{ message }}</p>
    <label class="field-group" for="server-url">
      <span>本机服务地址</span>
      <input
        id="server-url"
        :value="serverUrl"
        autocapitalize="off"
        autocomplete="url"
        inputmode="url"
        spellcheck="false"
        @input="updateServerUrl"
      />
    </label>
    <button class="button button--secondary" type="button" @click="emit('refresh')">
      重新检查
    </button>
  </section>
</template>
