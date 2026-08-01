export class ConcurrentTaskQueueError extends Error {
  readonly name = "ConcurrentTaskQueueError";

  constructor(readonly reason: "INVALID_CONCURRENCY") {
    super(`Concurrent task queue failed: ${reason}`);
  }
}

type QueuedTask = {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
  readonly task: () => Promise<void>;
};

/** Runs independent file transfers concurrently without imposing a batch cardinality limit. */
export class ConcurrentTaskQueue {
  private activeCount = 0;
  private readonly pending: QueuedTask[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new ConcurrentTaskQueueError("INVALID_CONCURRENCY");
    }
  }

  enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ reject, resolve, task });
      this.startAvailableTasks();
    });
  }

  private startAvailableTasks(): void {
    while (this.activeCount < this.maxConcurrent) {
      const next = this.pending.shift();
      if (next === undefined) {
        return;
      }
      this.activeCount += 1;
      void this.run(next);
    }
  }

  private async run(queued: QueuedTask): Promise<void> {
    try {
      await queued.task();
      queued.resolve();
    } catch (error) {
      queued.reject(error);
    } finally {
      this.activeCount -= 1;
      this.startAvailableTasks();
    }
  }
}
