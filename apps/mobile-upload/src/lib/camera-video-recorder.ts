const PREFERRED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export const CAMERA_RECORDING_ERROR_REASONS = {
  CAMERA_UNAVAILABLE: "CAMERA_UNAVAILABLE",
  RECORDING_EMPTY: "RECORDING_EMPTY",
  RECORDING_FAILED: "RECORDING_FAILED",
  RECORDING_NOT_ACTIVE: "RECORDING_NOT_ACTIVE",
} as const;

export type CameraRecordingErrorReason =
  (typeof CAMERA_RECORDING_ERROR_REASONS)[keyof typeof CAMERA_RECORDING_ERROR_REASONS];

export class CameraRecordingError extends Error {
  readonly name = "CameraRecordingError";

  constructor(readonly reason: CameraRecordingErrorReason) {
    super(`Camera recording failed: ${reason}`);
  }
}

export type CameraCapture = {
  readonly previewStream: MediaStream | undefined;
  release: () => void;
};

export type CameraRecorderTarget = {
  readonly mimeType: string;
  readonly state: "inactive" | "paused" | "recording";
  setDataHandler: (handler: (chunk: Blob) => void) => void;
  setErrorHandler: (handler: () => void) => void;
  setStopHandler: (handler: () => void) => void;
  start: () => void;
  stop: () => void;
};

export type CameraRecorderPlatform = {
  readonly createRecorder: (
    capture: CameraCapture,
    mimeType: string | undefined,
  ) => CameraRecorderTarget;
  readonly requestCapture: () => Promise<CameraCapture>;
  readonly supportsMimeType: (mimeType: string) => boolean;
};

export type CameraVideoRecorder = {
  readonly start: () => Promise<CameraCapture>;
  readonly stop: () => Promise<File>;
};

export function createCameraVideoRecorder(
  input: {
    readonly now?: () => Date;
    readonly onFailure?: (error: CameraRecordingError) => void;
    readonly platform?: CameraRecorderPlatform;
  } = {},
): CameraVideoRecorder {
  return new DefaultCameraVideoRecorder({
    now: input.now ?? (() => new Date()),
    onFailure: input.onFailure ?? (() => undefined),
    platform: input.platform,
  });
}

class DefaultCameraVideoRecorder implements CameraVideoRecorder {
  private active: ActiveRecording | undefined;

  constructor(
    private readonly input: {
      readonly now: () => Date;
      readonly onFailure: (error: CameraRecordingError) => void;
      readonly platform: CameraRecorderPlatform | undefined;
    },
  ) {}

  async start(): Promise<CameraCapture> {
    if (this.active !== undefined) {
      throw new CameraRecordingError("RECORDING_FAILED");
    }
    const platform = this.input.platform ?? browserCameraRecorderPlatform();
    let capture: CameraCapture;
    try {
      capture = await platform.requestCapture();
    } catch (error) {
      throw toCameraRecordingError(error);
    }
    try {
      const preferredMimeType = selectPreferredMimeType(platform);
      const recorder = platform.createRecorder(capture, preferredMimeType);
      const active: ActiveRecording = {
        capture,
        chunks: [],
        completion: undefined,
        fileName: cameraFileName(this.input.now(), recorder.mimeType),
        failure: undefined,
        mimeType: recorder.mimeType || preferredMimeType || "video/webm",
        recorder,
      };
      recorder.setDataHandler((chunk) => {
        if (chunk.size > 0) {
          active.chunks.push(chunk);
        }
      });
      recorder.setErrorHandler(() => {
        active.failure = new CameraRecordingError("RECORDING_FAILED");
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      });
      recorder.setStopHandler(() => this.finish(active));
      recorder.start();
      this.active = active;
      return capture;
    } catch (error) {
      capture.release();
      if (error instanceof CameraRecordingError) {
        throw error;
      }
      throw new CameraRecordingError("RECORDING_FAILED");
    }
  }

  stop(): Promise<File> {
    const active = this.active;
    if (active === undefined) {
      return Promise.reject(new CameraRecordingError("RECORDING_NOT_ACTIVE"));
    }
    if (active.completion !== undefined) {
      return Promise.reject(new CameraRecordingError("RECORDING_FAILED"));
    }
    return new Promise((resolve, reject) => {
      active.completion = { reject, resolve };
      if (active.recorder.state === "inactive") {
        this.finish(active);
        return;
      }
      active.recorder.stop();
    });
  }

  private finish(active: ActiveRecording): void {
    if (this.active !== active) {
      return;
    }
    this.active = undefined;
    active.capture.release();
    const result = active.completion;
    const failure = active.failure ?? recordingResultError(active);
    if (failure !== undefined) {
      if (result === undefined) {
        this.input.onFailure(failure);
      } else {
        result.reject(failure);
      }
      return;
    }
    const file = new File(active.chunks, active.fileName, {
      type: active.mimeType,
    });
    if (result === undefined) {
      this.input.onFailure(new CameraRecordingError("RECORDING_FAILED"));
      return;
    }
    result.resolve(file);
  }
}

type ActiveRecording = {
  readonly capture: CameraCapture;
  readonly chunks: Blob[];
  completion:
    | {
        readonly reject: (error: CameraRecordingError) => void;
        readonly resolve: (file: File) => void;
      }
    | undefined;
  readonly fileName: string;
  failure: CameraRecordingError | undefined;
  readonly mimeType: string;
  readonly recorder: CameraRecorderTarget;
};

function browserCameraRecorderPlatform(): CameraRecorderPlatform {
  if (
    typeof navigator === "undefined" ||
    navigator.mediaDevices === undefined ||
    typeof MediaRecorder === "undefined"
  ) {
    throw new CameraRecordingError("CAMERA_UNAVAILABLE");
  }
  return {
    createRecorder: (capture, mimeType) => {
      if (!(capture instanceof BrowserCameraCapture)) {
        throw new CameraRecordingError("RECORDING_FAILED");
      }
      const recorder =
        mimeType === undefined
          ? new MediaRecorder(capture.stream)
          : new MediaRecorder(capture.stream, { mimeType });
      return new BrowserCameraRecorder(recorder);
    },
    requestCapture: async () =>
      new BrowserCameraCapture(
        await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { facingMode: { ideal: "environment" } },
        }),
      ),
    supportsMimeType: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
  };
}

class BrowserCameraCapture implements CameraCapture {
  constructor(readonly stream: MediaStream) {}

  get previewStream(): MediaStream {
    return this.stream;
  }

  release(): void {
    for (const track of this.stream.getTracks()) {
      track.stop();
    }
  }
}

class BrowserCameraRecorder implements CameraRecorderTarget {
  constructor(private readonly recorder: MediaRecorder) {}

  get mimeType(): string {
    return this.recorder.mimeType;
  }

  get state(): "inactive" | "paused" | "recording" {
    return this.recorder.state;
  }

  setDataHandler(handler: (chunk: Blob) => void): void {
    this.recorder.ondataavailable = (event) => handler(event.data);
  }

  setErrorHandler(handler: () => void): void {
    this.recorder.onerror = () => handler();
  }

  setStopHandler(handler: () => void): void {
    this.recorder.onstop = () => handler();
  }

  start(): void {
    this.recorder.start();
  }

  stop(): void {
    this.recorder.stop();
  }
}

function selectPreferredMimeType(
  platform: CameraRecorderPlatform,
): string | undefined {
  return PREFERRED_VIDEO_MIME_TYPES.find((mimeType) =>
    platform.supportsMimeType(mimeType),
  );
}

function cameraFileName(now: Date, mimeType: string): string {
  const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  return `camera-${timestamp}.${mimeType === "video/mp4" ? "mp4" : "webm"}`;
}

function recordingResultError(
  active: ActiveRecording,
): CameraRecordingError | undefined {
  return active.chunks.length === 0
    ? new CameraRecordingError("RECORDING_EMPTY")
    : undefined;
}

function toCameraRecordingError(error: unknown): CameraRecordingError {
  if (error instanceof CameraRecordingError) {
    return error;
  }
  return new CameraRecordingError("CAMERA_UNAVAILABLE");
}
