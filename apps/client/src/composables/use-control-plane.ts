import { computed, ref } from "vue";

import {
  ControlPlaneError,
  type CreatedProjectUploadKey,
  type CreateProjectTargetInput,
  type CreateProjectUploadKeyInput,
  createControlPlaneApi,
  type ProjectTargetSummary,
  type StorageStatus,
} from "@/lib/control-plane-api";

export type ConnectionState = "checking" | "offline" | "online";

export type NamedProjectTarget = ProjectTargetSummary;

export type CreateProjectTargetOutcome =
  | { readonly kind: "created" }
  | { readonly kind: "rejected"; readonly message: string };

export type CreateProjectUploadKeyOutcome =
  | { readonly created: CreatedProjectUploadKey; readonly kind: "created" }
  | { readonly kind: "rejected"; readonly message: string };

export function useControlPlane() {
  const serverUrl = ref("http://127.0.0.1:31887");
  const connectionState = ref<ConnectionState>("checking");
  const message = ref("正在检查本机服务。");
  const targets = ref<readonly NamedProjectTarget[]>([]);
  const storageStatus = ref<StorageStatus>();
  const isCreatingKey = ref(false);
  const isCreatingTarget = ref(false);
  const canCreateTarget = computed(
    () => connectionState.value === "online" && !isCreatingTarget.value,
  );
  const canCreateKey = computed(
    () => connectionState.value === "online" && !isCreatingKey.value,
  );

  async function refreshHealth(): Promise<void> {
    connectionState.value = "checking";
    message.value = "正在检查本机服务。";
    try {
      await createControlPlaneApi(serverUrl.value).health();
      const api = createControlPlaneApi(serverUrl.value);
      const [loadedTargets, loadedStorageStatus] = await Promise.all([
        api.listProjectTargets(),
        api.storageStatus(),
      ]);
      targets.value = loadedTargets;
      storageStatus.value = loadedStorageStatus;
      connectionState.value = "online";
      message.value = "本机服务正在运行。素材与项目数据仍保留在这台 Mac 上。";
    } catch (error) {
      connectionState.value = "offline";
      message.value = errorMessage(error, "本机服务不可用。");
    }
  }

  async function createProjectTarget(
    input: CreateProjectTargetInput,
  ): Promise<CreateProjectTargetOutcome> {
    isCreatingTarget.value = true;
    try {
      const target = await createControlPlaneApi(
        serverUrl.value,
      ).createProjectTarget(input);
      targets.value = [...targets.value, { ...input, ...target }];
      message.value = `已创建“${input.projectName} / ${input.categoryName}”素材目标。`;
      return { kind: "created" };
    } catch (error) {
      return {
        kind: "rejected",
        message: errorMessage(error, "创建素材目标失败。"),
      };
    } finally {
      isCreatingTarget.value = false;
    }
  }

  async function createProjectUploadKey(
    input: CreateProjectUploadKeyInput,
  ): Promise<CreateProjectUploadKeyOutcome> {
    isCreatingKey.value = true;
    try {
      const created = await createControlPlaneApi(
        serverUrl.value,
      ).createProjectUploadKey(input);
      message.value = `已为“${created.uploadKey.directoryName}”创建一次性手机配对 Key。`;
      return { created, kind: "created" };
    } catch (error) {
      return {
        kind: "rejected",
        message: errorMessage(error, "创建手机配对 Key 失败。"),
      };
    } finally {
      isCreatingKey.value = false;
    }
  }

  return {
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
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ControlPlaneError) {
    return error.messageForUser;
  }
  return fallback;
}
