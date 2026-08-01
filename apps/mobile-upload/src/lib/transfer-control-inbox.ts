import {
  type TransferControlMessage,
  transferControlMessageSchema,
  type UploadId,
} from "@jianying/contracts";

export class TransferControlInboxError extends Error {
  readonly name = "TransferControlInboxError";

  constructor(
    readonly reason:
      | "CONTROL_MESSAGE_INVALID"
      | "CONTROL_MESSAGE_REJECTED"
      | "CONTROL_MESSAGE_TIMED_OUT",
  ) {
    super(`Mobile transfer control failed: ${reason}`);
  }
}

export class TransferControlInbox {
  private readonly messages: TransferControlMessage[] = [];
  private terminalError: Error | undefined;
  private waiter:
    | {
        readonly reject: (error: Error) => void;
        readonly resolve: (message: TransferControlMessage) => void;
        readonly timer: ReturnType<typeof setTimeout>;
        readonly predicate: (message: TransferControlMessage) => boolean;
      }
    | undefined;

  receive(rawMessage: unknown): void {
    if (typeof rawMessage !== "string") {
      this.reject(new TransferControlInboxError("CONTROL_MESSAGE_INVALID"));
      return;
    }
    const parsed = parseControlMessage(rawMessage);
    if (parsed === undefined) {
      this.reject(new TransferControlInboxError("CONTROL_MESSAGE_INVALID"));
      return;
    }
    const waiting = this.waiter;
    if (waiting?.predicate(parsed) === true) {
      this.clearWaiter();
      waiting.resolve(parsed);
      return;
    }
    this.messages.push(parsed);
  }

  waitFor(
    uploadId: UploadId,
    predicate: (message: TransferControlMessage) => boolean,
    timeoutMs = 60_000,
  ): Promise<TransferControlMessage> {
    if (this.terminalError !== undefined) {
      return Promise.reject(this.terminalError);
    }
    const queuedIndex = this.messages.findIndex(
      (message) => message.uploadId === uploadId && predicate(message),
    );
    if (queuedIndex >= 0) {
      const queued = this.messages.splice(queuedIndex, 1)[0];
      if (queued === undefined) {
        return Promise.reject(
          new TransferControlInboxError("CONTROL_MESSAGE_INVALID"),
        );
      }
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.reject(
            new TransferControlInboxError("CONTROL_MESSAGE_TIMED_OUT"),
          ),
        timeoutMs,
      );
      this.waiter = {
        predicate: (message) =>
          message.uploadId === uploadId && predicate(message),
        reject,
        resolve,
        timer,
      };
    });
  }

  reject(error: Error): void {
    if (this.terminalError !== undefined) {
      return;
    }
    this.terminalError = error;
    const waiting = this.waiter;
    if (waiting === undefined) {
      return;
    }
    this.clearWaiter();
    waiting.reject(error);
  }

  private clearWaiter(): void {
    const waiting = this.waiter;
    if (waiting !== undefined) {
      clearTimeout(waiting.timer);
    }
    this.waiter = undefined;
  }
}

function parseControlMessage(
  value: string,
): TransferControlMessage | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  const parsed = transferControlMessageSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}
