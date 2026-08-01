import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type MaterialLayout = {
  readonly blobDirectory: string;
  readonly manifestDirectory: string;
  readonly materialRootPath: string;
  readonly stagingDirectory: string;
};

export class StoragePathError extends Error {
  readonly name = "StoragePathError";

  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${reason}: ${path}`);
  }
}

export class StoragePositionUnsupportedError extends Error {
  readonly name = "StoragePositionUnsupportedError";

  constructor(readonly offsetBytes: bigint) {
    super(`The local file API cannot safely address offset ${offsetBytes}`);
  }
}

export class StorageWriteError extends Error {
  readonly name = "StorageWriteError";

  constructor(readonly path: string) {
    super(`The local file system made no progress while writing ${path}`);
  }
}

export async function createMaterialLayout(
  materialRootPath: string,
): Promise<MaterialLayout> {
  await mkdir(materialRootPath, { recursive: true });
  const resolvedRootPath = await realpath(materialRootPath);
  await ensureRealDirectory(resolvedRootPath);

  const stagingDirectory = join(resolvedRootPath, ".staging");
  const blobDirectory = join(resolvedRootPath, "blobs");
  const manifestDirectory = join(resolvedRootPath, ".manifests");
  await Promise.all(
    [stagingDirectory, blobDirectory, manifestDirectory].map(
      async (directory) => {
        await mkdir(directory, { recursive: true });
        await ensureRealDirectory(directory);
      },
    ),
  );

  return {
    blobDirectory,
    manifestDirectory,
    materialRootPath: resolvedRootPath,
    stagingDirectory,
  };
}

/** Returns the user-available bytes on the volume that contains the material root. */
export async function availableStorageBytes(path: string): Promise<bigint> {
  const filesystem = await statfs(path, { bigint: true });
  return filesystem.bavail * filesystem.bsize;
}

export function blobPath(layout: MaterialLayout, sha256: string): string {
  return join(layout.blobDirectory, sha256.slice(0, 2), sha256);
}

export function manifestPath(layout: MaterialLayout, uploadId: string): string {
  return join(layout.manifestDirectory, `${uploadId}.json`);
}

export function stagingPath(layout: MaterialLayout, uploadId: string): string {
  return join(layout.stagingDirectory, `${uploadId}.partial`);
}

export async function ensureEmptyStagingFile(path: string): Promise<void> {
  await writeFile(path, "", { encoding: "utf8", flag: "wx" });
  await syncFile(path);
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function moveFileWithinMaterialRoot(input: {
  readonly destinationPath: string;
  readonly sourcePath: string;
}): Promise<void> {
  await mkdir(dirname(input.destinationPath), { recursive: true });
  await rename(input.sourcePath, input.destinationPath);
  await syncDirectory(dirname(input.destinationPath));
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function removeStagingFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function writeChunkAtOffset(input: {
  readonly bytes: Uint8Array;
  readonly offsetBytes: bigint;
  readonly path: string;
}): Promise<void> {
  const endOffset = input.offsetBytes + BigInt(input.bytes.byteLength);
  if (endOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StoragePositionUnsupportedError(input.offsetBytes);
  }

  const file = await open(input.path, "r+");
  try {
    let writtenBytes = 0;
    const initialPosition = Number(input.offsetBytes);
    while (writtenBytes < input.bytes.byteLength) {
      const result = await file.write(
        input.bytes,
        writtenBytes,
        input.bytes.byteLength - writtenBytes,
        initialPosition + writtenBytes,
      );
      if (result.bytesWritten === 0) {
        throw new StorageWriteError(input.path);
      }
      writtenBytes += result.bytesWritten;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function writeManifestAtomically(input: {
  readonly manifest: string;
  readonly path: string;
}): Promise<void> {
  const temporaryPath = join(
    dirname(input.path),
    `.${basename(input.path)}.${randomUUID()}`,
  );
  await writeFile(temporaryPath, input.manifest, {
    encoding: "utf8",
    flag: "wx",
  });
  await syncFile(temporaryPath);
  await rename(temporaryPath, input.path);
  await syncDirectory(dirname(input.path));
}

async function ensureRealDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new StoragePathError(path, "Expected a non-symlink directory");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
