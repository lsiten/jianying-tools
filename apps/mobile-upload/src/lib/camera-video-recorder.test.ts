import { describe, expect, test } from "vitest";

import {
  type CameraCapture,
  type CameraRecorderPlatform,
  type CameraRecorderTarget,
  createCameraVideoRecorder,
} from "./camera-video-recorder.js";

describe("camera video recorder", () => {
  test("turns a stopped camera recording into an uploadable video file", async () => {
    // Given: a camera platform that can record MP4 video.
    const capture = new FakeCapture();
    const recorder = new FakeRecorder("video/mp4");
    const platform = fakePlatform(capture, recorder, ["video/mp4"]);
    const camera = createCameraVideoRecorder({
      now: () => new Date("2026-07-31T12:34:56.000Z"),
      platform,
    });

    // When: the user starts, records, and stops a short clip.
    await camera.start();
    recorder.emitChunk(new Blob(["video-bytes"], { type: "video/mp4" }));
    const file = await camera.stop();

    // Then: the exact video bytes become a File for the normal upload queue.
    expect(file.name).toBe("camera-2026-07-31T12-34-56.mp4");
    expect(file.type).toBe("video/mp4");
    expect(await file.text()).toBe("video-bytes");
    expect(capture.released).toBe(true);
  });

  test("rejects an empty recording after releasing the camera", async () => {
    // Given: a supported camera recorder that did not produce a media chunk.
    const capture = new FakeCapture();
    const recorder = new FakeRecorder("video/mp4");
    const camera = createCameraVideoRecorder({
      platform: fakePlatform(capture, recorder, ["video/mp4"]),
    });

    // When: recording ends without a usable video payload.
    await camera.start();
    const result = camera.stop();

    // Then: no empty File enters the upload queue and hardware is released.
    await expect(result).rejects.toMatchObject({
      reason: "RECORDING_EMPTY",
    });
    expect(capture.released).toBe(true);
  });
});

class FakeCapture implements CameraCapture {
  released = false;
  readonly previewStream = undefined;

  release(): void {
    this.released = true;
  }
}

class FakeRecorder implements CameraRecorderTarget {
  private dataHandler: ((chunk: Blob) => void) | undefined;
  private stopHandler: (() => void) | undefined;
  state: "inactive" | "recording" = "inactive";

  constructor(readonly mimeType: string) {}

  emitChunk(chunk: Blob): void {
    this.dataHandler?.(chunk);
  }

  setDataHandler(handler: (chunk: Blob) => void): void {
    this.dataHandler = handler;
  }

  setErrorHandler(handler: () => void): void {
    void handler;
  }

  setStopHandler(handler: () => void): void {
    this.stopHandler = handler;
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.stopHandler?.();
  }
}

function fakePlatform(
  capture: CameraCapture,
  recorder: CameraRecorderTarget,
  supportedMimeTypes: readonly string[],
): CameraRecorderPlatform {
  return {
    createRecorder: () => recorder,
    requestCapture: async () => capture,
    supportsMimeType: (mimeType) => supportedMimeTypes.includes(mimeType),
  };
}
