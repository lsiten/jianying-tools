import { z } from "zod";

const terminalTransferEventSchema = z
  .object({
    outcome: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("transfer_cancelled"),
        upload_id: z.string().min(1),
      }),
      z.object({
        kind: z.literal("transfer_finished"),
        upload_id: z.string().min(1),
      }),
      z.object({
        kind: z.literal("unbound_session"),
        session_id: z.string().uuid(),
      }),
    ]),
    session_id: z.string().uuid(),
  })
  .strict();

export type NativeTransferNotice = {
  readonly detail: string;
  readonly kind: "cancelled" | "completed";
  readonly title: string;
};

/** Converts an untrusted native terminal event into concise, actionable UI copy. */
export function parseNativeTransferNotice(
  payload: unknown,
): NativeTransferNotice | undefined {
  const parsed = terminalTransferEventSchema.safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }
  switch (parsed.data.outcome.kind) {
    case "transfer_cancelled":
      return {
        detail: "这次传输已由 Mac 取消，不会继续发送素材。",
        kind: "cancelled",
        title: "传输已取消",
      };
    case "transfer_finished":
      return {
        detail: "信令会话已结束；素材是否可用仍以 Mac 的完整性确认结果为准。",
        kind: "completed",
        title: "传输会话已结束",
      };
    case "unbound_session":
      return undefined;
  }
}
