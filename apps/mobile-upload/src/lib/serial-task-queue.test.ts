import { describe, expect, test } from "vitest";

import { SerialTaskQueue } from "./serial-task-queue.js";

describe("SerialTaskQueue", () => {
  test("preserves every large-batch task in order without concurrent execution", async () => {
    // Given: a large picker selection followed by another selection while it is active.
    const queue = new SerialTaskQueue();
    const batchSize = 1_024;
    const started: number[] = [];
    let activeCount = 0;
    let maximumActiveCount = 0;

    // When: every picked item enters the shared transfer queue.
    const work = Array.from({ length: batchSize }, (_, index) =>
      queue.enqueue(async () => {
        activeCount += 1;
        maximumActiveCount = Math.max(maximumActiveCount, activeCount);
        started.push(index);
        await Promise.resolve();
        activeCount -= 1;
      }),
    );
    await Promise.all(work);

    // Then: no picker-level cardinality limit drops an item or opens two WebRTC transfers.
    expect(started).toEqual(
      Array.from({ length: batchSize }, (_, index) => index),
    );
    expect(maximumActiveCount).toBe(1);
  });

  test("continues the batch after one item fails", async () => {
    // Given: one material whose transfer fails before the next selected material.
    const queue = new SerialTaskQueue();
    const completed: string[] = [];

    // When: both items are admitted to the unbounded queue.
    const failed = queue.enqueue(async () => {
      throw new Error("direct connection failed");
    });
    const next = queue.enqueue(async () => {
      completed.push("next");
    });

    // Then: a terminal item error never abandons the remaining batch.
    await expect(failed).rejects.toThrow("direct connection failed");
    await next;
    expect(completed).toEqual(["next"]);
  });
});
