import {
  controlNodeIdSchema,
  type ProjectUploadKeyId,
  projectUploadKeyIdSchema,
} from "@jianying/contracts";

export class ProjectUploadKeyParseError extends Error {
  readonly name = "ProjectUploadKeyParseError";

  constructor(readonly reason: "INVALID_PROJECT_UPLOAD_KEY") {
    super(`Project upload Key parse failed: ${reason}`);
  }
}

export type ParsedProjectUploadKey = {
  readonly keyId: ProjectUploadKeyId;
  readonly nodeId: string;
};

/** Extracts routing identifiers locally; callers retain the raw Key only until its single redemption request is sent. */
export function parseProjectUploadKey(rawKey: string): ParsedProjectUploadKey {
  const parts = rawKey.trim().split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "jyup1" ||
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[3] === undefined ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[3])
  ) {
    throw new ProjectUploadKeyParseError("INVALID_PROJECT_UPLOAD_KEY");
  }
  const nodeId = controlNodeIdSchema.safeParse(parts[1]);
  const keyId = projectUploadKeyIdSchema.safeParse(parts[2]);
  if (!nodeId.success || !keyId.success) {
    throw new ProjectUploadKeyParseError("INVALID_PROJECT_UPLOAD_KEY");
  }
  return { keyId: keyId.data, nodeId: nodeId.data };
}
