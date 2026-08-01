import { projectUploadKeyIdSchema, uploadIdSchema } from "@jianying/contracts";
import { describe, expect, test } from "vitest";

import { resumableUploadItem } from "./mobile-upload-presentation.js";

describe("resumable upload presentation", () => {
  test("requires file reselection after browser reload", () => {
    const item = resumableUploadItem({
      directoryName: "傍晚散步",
      expectedSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fileName: "walk.mp4",
      keyId: projectUploadKeyIdSchema.parse(
        "2ee77da2-3d07-4d91-b290-f2c560ae046d",
      ),
      nodeId: "test_upload_node_id_01",
      sizeBytes: 1_024,
      uploadId: uploadIdSchema.parse("3ee77da2-3d07-4d91-b290-f2c560ae046d"),
    });

    expect(item).toMatchObject({
      status: "awaiting_file",
      statusDetail: expect.stringContaining("请选择同一文件"),
    });
  });
});
