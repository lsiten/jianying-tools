import { describe, expect, test } from "vitest";

import { mobileUploadErrorDetail } from "./mobile-upload-item.js";
import { WebRtcFileTransferError } from "./webrtc-file-transfer-error.js";

describe("mobile upload error presentation", () => {
  test("keeps invalid ICE configuration and ordinary connection failure distinct", () => {
    expect(
      mobileUploadErrorDetail(new WebRtcFileTransferError("CONNECTION_FAILED")),
    ).toContain("连接失败");
    expect(
      mobileUploadErrorDetail(new WebRtcFileTransferError("SIGNALING_INVALID")),
    ).toContain("ICE 配置无效");
    expect(
      mobileUploadErrorDetail(new WebRtcFileTransferError("CONNECTION_FAILED")),
    ).toContain("连接失败");
  });
});
