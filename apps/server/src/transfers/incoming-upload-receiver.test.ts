import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDataChunkPacket } from "@jianying/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  createMaterialLibrary,
  type MaterialLibrary,
} from "../uploads/material-library.js";
import { createIncomingUploadReceiver } from "./incoming-upload-receiver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

describe("incoming WebRTC upload receiver", () => {
  test("acknowledges durable data and emits ready only after final commit", async () => {
    // Given: an already authorized upload session for a one-chunk material.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const receiver = createIncomingUploadReceiver({
      authorize: acceptTestAuthorization,
      materialLibrary: library,
      uploadId: upload.uploadId,
    });
    const packet = encodeDataChunkPacket({
      checksumSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      chunkIndex: 0n,
      offsetBytes: 0n,
      payload: new TextEncoder().encode("hello"),
    });
    await authorizeReceiver(receiver, upload.uploadId);

    // When: the binary data and complete command arrive through separate DataChannels.
    const acknowledgement = await receiver.receiveData(packet);
    const completion = await receiver.receiveControl(
      JSON.stringify({ type: "complete", uploadId: upload.uploadId }),
    );

    // Then: the client receives durable acknowledgement followed by final material readiness.
    expect(acknowledgement).toEqual({
      ackEpoch: "1",
      receivedBytes: "5",
      type: "ack",
      uploadId: upload.uploadId,
    });
    expect(completion).toMatchObject({
      type: "ready",
      uploadId: upload.uploadId,
    });
  });

  test("converts a bad data packet into a protocol nack before persistence", async () => {
    // Given: an authorized upload receiver with no durable chunks.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const receiver = createIncomingUploadReceiver({
      authorize: acceptTestAuthorization,
      materialLibrary: library,
      uploadId: upload.uploadId,
    });
    const packet = encodeDataChunkPacket({
      checksumSha256:
        "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
      chunkIndex: 0n,
      offsetBytes: 0n,
      payload: new TextEncoder().encode("hello"),
    });
    await authorizeReceiver(receiver, upload.uploadId);

    // When: the packet declares a checksum that does not match its payload.
    const response = await receiver.receiveData(packet);

    // Then: no acknowledgement is emitted and the sender receives a resumable failure code.
    expect(response).toEqual({
      code: "CHUNK_CHECKSUM_MISMATCH",
      type: "nack",
      uploadId: upload.uploadId,
    });
    expect(library.getUpload(upload.uploadId)).toMatchObject({
      ackEpoch: 0n,
      receivedBytes: 0n,
    });
  });

  test("cancels an authorized upload durably and rejects all later bytes", async () => {
    // Given: a transfer that has not yet received any durable material bytes.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const receiver = createIncomingUploadReceiver({
      authorize: acceptTestAuthorization,
      materialLibrary: library,
      uploadId: upload.uploadId,
    });
    const packet = encodeDataChunkPacket({
      checksumSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      chunkIndex: 0n,
      offsetBytes: 0n,
      payload: new TextEncoder().encode("hello"),
    });
    await authorizeReceiver(receiver, upload.uploadId);

    // When: the mobile queue cancels the transfer before it starts sending.
    const cancellation = await receiver.receiveControl(
      JSON.stringify({ type: "cancel", uploadId: upload.uploadId }),
    );
    const latePacket = await receiver.receiveData(packet);

    // Then: the terminal cancellation is observable and cannot be revived by late packets.
    expect(cancellation).toEqual({ type: "cancel", uploadId: upload.uploadId });
    expect(library.getUpload(upload.uploadId).state).toBe("cancelled");
    expect(latePacket).toEqual({
      code: "UPLOAD_STATE_INVALID",
      type: "nack",
      uploadId: upload.uploadId,
    });
  });

  test("rejects material bytes until the transfer grant is authorized", async () => {
    // Given: an upload receiver created without a valid mobile grant.
    const library = await createTestLibrary();
    const upload = await createUpload(library);
    const receiver = createIncomingUploadReceiver({
      materialLibrary: library,
      uploadId: upload.uploadId,
    });
    const packet = encodeDataChunkPacket({
      checksumSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      chunkIndex: 0n,
      offsetBytes: 0n,
      payload: new TextEncoder().encode("hello"),
    });

    // When: a peer attempts to write before presenting an accepted authorization frame.
    const response = await receiver.receiveData(packet);

    // Then: no byte is acknowledged or persisted merely because signaling succeeded.
    expect(response).toEqual({
      code: "AUTHORIZE_REQUIRED",
      type: "nack",
      uploadId: upload.uploadId,
    });
    expect(library.getUpload(upload.uploadId)).toMatchObject({
      ackEpoch: 0n,
      receivedBytes: 0n,
    });
  });

  test("returns a resumable code when the Node file API cannot address a valid 64-bit protocol offset", async () => {
    // Given: a real storage reservation for a file beyond JavaScript's numeric addressing range.
    const expectedSizeBytes = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const library = await createTestLibrary(expectedSizeBytes);
    const upload = await createUpload(library, expectedSizeBytes);
    const receiver = createIncomingUploadReceiver({
      authorize: acceptTestAuthorization,
      materialLibrary: library,
      uploadId: upload.uploadId,
    });
    const packet = encodeDataChunkPacket({
      checksumSha256:
        "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      chunkIndex: 0n,
      offsetBytes: BigInt(Number.MAX_SAFE_INTEGER),
      payload: new TextEncoder().encode("x"),
    });
    await authorizeReceiver(receiver, upload.uploadId);

    // When: the protocol-valid final byte reaches the Node storage boundary.
    const response = await receiver.receiveData(packet);

    // Then: the sender is told about the actual platform constraint rather than losing its retry state.
    expect(response).toEqual({
      code: "STORAGE_POSITION_UNSUPPORTED",
      type: "nack",
      uploadId: upload.uploadId,
    });
  });
});

function acceptTestAuthorization(): { readonly kind: "accepted" } {
  return { kind: "accepted" };
}

async function authorizeReceiver(
  receiver: ReturnType<typeof createIncomingUploadReceiver>,
  uploadId: string,
): Promise<void> {
  await expect(
    receiver.receiveControl(
      JSON.stringify({
        deviceId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
        deviceProof: "test-device-proof",
        dtlsFingerprint: "test-dtls-fingerprint",
        grant: "test-grant",
        type: "authorize",
        uploadId,
      }),
    ),
  ).resolves.toMatchObject({ type: "ack", uploadId });
}

async function createTestLibrary(
  availableBytes = 1_000_000_000_000_000n,
): Promise<MaterialLibrary> {
  const directory = await mkdtemp(join(tmpdir(), "jianying-webrtc-receiver-"));
  temporaryDirectories.push(directory);
  return createMaterialLibrary({
    availableBytes: async () => availableBytes,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
  });
}

async function createUpload(
  materialLibrary: MaterialLibrary,
  expectedSizeBytes = 5n,
): Promise<Awaited<ReturnType<MaterialLibrary["createUpload"]>>> {
  const target = materialLibrary.createProjectTarget({
    categoryName: "raw-video",
    projectName: "pet-vlog",
  });
  return materialLibrary.createUpload({
    expectedSha256:
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    expectedSizeBytes,
    fileName: "pet.mov",
    target,
  });
}
