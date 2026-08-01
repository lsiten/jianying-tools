import { describe, expect, test } from "vitest";

import {
  type ProjectUploadKeyParseError,
  parseProjectUploadKey,
} from "./project-upload-key.js";

describe("project upload Key parser", () => {
  test("derives only the node and Key identifiers needed to open a mobile control route", () => {
    // Given: a one-time Key copied from the desktop control plane.
    const rawKey =
      "jyup1.t7NHTBv9_MpK3VxW6RzQ2A.5ee77da2-3d07-4d91-b290-f2c560ae046d.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // When: the H5 prepares a redemption request.
    const parsed = parseProjectUploadKey(rawKey);

    // Then: it retains no secret segment after the request has been constructed.
    expect(parsed).toEqual({
      keyId: "5ee77da2-3d07-4d91-b290-f2c560ae046d",
      nodeId: "t7NHTBv9_MpK3VxW6RzQ2A",
    });
    expect(Object.values(parsed)).not.toContain(rawKey.split(".")[3]);
  });

  test("rejects a malformed Key before opening a public WebSocket", () => {
    // Given: a Key with a malformed node segment.
    const malformedKey =
      "jyup1.not-a-node.5ee77da2-3d07-4d91-b290-f2c560ae046d.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // When / Then: the parser raises a typed local validation error.
    expect(() => parseProjectUploadKey(malformedKey)).toThrow(
      expect.objectContaining({
        name: "ProjectUploadKeyParseError",
        reason: "INVALID_PROJECT_UPLOAD_KEY",
      } satisfies Partial<ProjectUploadKeyParseError>),
    );
  });
});
