import type { UploadId } from "@jianying/contracts";

/** Serializes reservations that share the one local material volume. */
export class CreationOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Serializes every state-changing action for one durable upload identifier. */
export class UploadOperationQueue {
  private readonly tails = new Map<UploadId, Promise<void>>();

  run<T>(uploadId: UploadId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(uploadId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(uploadId, tail);
    return result.finally(() => {
      if (this.tails.get(uploadId) === tail) {
        this.tails.delete(uploadId);
      }
    });
  }
}
