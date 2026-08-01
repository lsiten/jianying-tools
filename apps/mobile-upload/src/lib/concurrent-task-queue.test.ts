import { describe, expect, test } from "vitest";

import { ConcurrentTaskQueue } from "./concurrent-task-queue.js";

describe("ConcurrentTaskQueue", () => {
  test("starts several files concurrently without dropping a large batch", async () => {
    // Given: a bounded parallel uploader and a large picker selection.
    const queue = new ConcurrentTaskQueue(3);
    const started: number[] = [];
    const releases = new Map<number, () => void>();
    let activeCount = 0;
    let maximumActiveCount = 0;

    const work = Array.from({ length: 1_024 }, (_value, index) =>
      queue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            started.push(index);
            activeCount += 1;
            maximumActiveCount = Math.max(maximumActiveCount, activeCount);
            releases.set(index, () => {
              activeCount -= 1;
              resolve();
            });
          }),
      ),
    );

    // When: the active work is released as each parallel slot becomes free.
    for (let index = 0; index < 1_024; index += 1) {
      while (!releases.has(index)) {
        await Promise.resolve();
      }
      releases.get(index)?.();
    }
    await Promise.all(work);

    // Then: every selected file runs and at most the configured number is active.
    expect(started).toEqual(
      Array.from({ length: 1_024 }, (_value, index) => index),
    );
    expect(maximumActiveCount).toBe(3);
  });

  test("continues a parallel batch when one file fails", async () => {
    // Given: one failed file beside two independently transferable files.
    const queue = new ConcurrentTaskQueue(2);
    const completed: string[] = [];

    // When: every file is admitted to the same bounded parallel queue.
    const failed = queue.enqueue(async () => {
      throw new Error("direct connection failed");
    });
    const first = queue.enqueue(async () => {
      completed.push("first");
    });
    const second = queue.enqueue(async () => {
      completed.push("second");
    });

    // Then: an isolated failure does not abandon later work.
    await expect(failed).rejects.toThrow("direct connection failed");
    await Promise.all([first, second]);
    expect(completed).toEqual(["first", "second"]);
  });
});
