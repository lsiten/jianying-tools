/**
 * Serializes asynchronous work without imposing a cardinality limit on the
 * queued tasks. A rejected task never prevents the following task from
 * starting.
 */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
