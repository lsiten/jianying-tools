import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onMounted, onUnmounted, ref } from "vue";

import {
  type NativeTransferNotice,
  parseNativeTransferNotice,
} from "@/lib/native-transfer-notice";

const TERMINAL_TRANSFER_EVENT = "mobile-signaling-terminated";

/** Listens only inside Tauri, keeping the same Vue bundle safe to run in an ordinary local browser. */
export function useNativeTransferNotice() {
  const notice = ref<NativeTransferNotice>();
  const listenerError = ref<string>();
  let unlisten: UnlistenFn | undefined;

  onMounted(() => {
    void startListening();
  });
  onUnmounted(() => unlisten?.());

  async function startListening(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    try {
      unlisten = await listen(TERMINAL_TRANSFER_EVENT, (event) => {
        notice.value = parseNativeTransferNotice(event.payload);
      });
    } catch (error) {
      listenerError.value =
        error instanceof Error ? error.message : "无法监听本机传输状态。";
    }
  }

  return { listenerError, notice };
}
