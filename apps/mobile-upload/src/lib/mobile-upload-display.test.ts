import { describe, expect, it } from "vitest";

import { formatUploadBytes, uploadStatusLabel } from "./mobile-upload-display";

describe("formatUploadBytes", () => {
  it("uses progressively larger units without capping an upload display at MB", () => {
    expect(formatUploadBytes(999)).toBe("999 B");
    expect(formatUploadBytes(1_024)).toBe("1.0 KB");
    expect(formatUploadBytes(1_024 ** 3)).toBe("1.0 GB");
    expect(formatUploadBytes(1_024 ** 4)).toBe("1.0 TB");
  });
});

describe("uploadStatusLabel", () => {
  it("explains the resumable upload state in Chinese", () => {
    expect(uploadStatusLabel("awaiting_file")).toBe("待续传");
  });
});
