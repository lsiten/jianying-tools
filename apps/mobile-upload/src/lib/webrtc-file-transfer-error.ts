export class WebRtcFileTransferError extends Error {
  readonly name = "WebRtcFileTransferError";

  constructor(
    readonly reason:
      | "CONNECTION_FAILED"
      | "CONTROL_REJECTED"
      | "DTLS_FINGERPRINT_UNAVAILABLE"
      | "SIGNALING_INVALID"
      | "SIGNALING_TIMED_OUT",
  ) {
    super(`WebRTC file transfer failed: ${reason}`);
  }
}

export function isWebRtcSessionRefreshable(error: unknown): boolean {
  return (
    error instanceof WebRtcFileTransferError &&
    (error.reason === "CONNECTION_FAILED" ||
      error.reason === "SIGNALING_TIMED_OUT")
  );
}
