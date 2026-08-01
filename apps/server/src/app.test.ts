import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectTargetResponseSchema,
  createTransferSessionResponseSchema,
  createUploadResponseSchema,
  deviceIdSchema,
  listProjectTargetsResponseSchema,
  storageStatusResponseSchema,
  webRtcSessionIdSchema,
} from "@jianying/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { createApp } from "./app.js";
import { UploadSessionCoordinatorError } from "./transfers/upload-session-coordinator.js";
import type { UploadTransferService } from "./transfers/upload-transfer-service.js";
import {
  createMaterialLibrary,
  type MaterialLibrary,
} from "./uploads/material-library.js";

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

describe("local HTTP control plane", () => {
  test("permits only Tauri and loopback WebView origins to call the local control plane", async () => {
    // Given: a local HTTP control plane used by a desktop browser and Tauri WebViews.
    const library = await createTestLibrary();
    const app = createApp({ materialLibrary: library });

    // When: a loopback development WebView and an unrelated web origin request health.
    const loopbackResponse = await app.request("http://localhost/health", {
      headers: { origin: "http://127.0.0.1:5174" },
    });
    const tauriResponse = await app.request("http://localhost/health", {
      headers: { origin: "tauri://localhost" },
    });
    const remoteResponse = await app.request("http://localhost/health", {
      headers: { origin: "https://untrusted.example" },
    });

    // Then: only the local application origins receive a CORS grant.
    expect(loopbackResponse.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5174",
    );
    expect(tauriResponse.headers.get("access-control-allow-origin")).toBe(
      "tauri://localhost",
    );
    expect(
      remoteResponse.headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  test("creates an upload session and returns its durable state", async () => {
    // Given: an isolated local material library behind the HTTP control plane.
    const library = await createTestLibrary();
    const app = createApp({ materialLibrary: library });

    // When: the client creates its target, then requests an upload session.
    const targetResponse = await app.request(
      "http://localhost/api/v1/project-targets",
      {
        body: JSON.stringify({
          categoryName: "raw-video",
          projectName: "pet-vlog",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const target = createProjectTargetResponseSchema.parse(
      await targetResponse.json(),
    );
    const uploadResponse = await app.request(
      "http://localhost/api/v1/uploads",
      {
        body: JSON.stringify({
          expectedSha256:
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
          expectedSizeBytes: "1",
          fileName: "pet.mov",
          target,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const upload = createUploadResponseSchema.parse(
      await uploadResponse.json(),
    );
    const stateResponse = await app.request(
      `http://localhost/api/v1/uploads/${upload.uploadId}`,
    );

    // Then: control-plane clients receive no material bytes, only durable session state.
    expect(targetResponse.status).toBe(201);
    expect(uploadResponse.status).toBe(201);
    expect(await stateResponse.json()).toMatchObject({
      ackEpoch: "0",
      receivedBytes: "0",
      state: "transferring",
      uploadId: upload.uploadId,
    });
  });

  test("creates a one-time project upload Key that names its bound directory", async () => {
    // Given: a desktop-created project target and a local control plane with its Key pepper.
    const library = await createTestLibrary();
    const app = createApp({ materialLibrary: library });
    const targetResponse = await app.request(
      "http://localhost/api/v1/project-targets",
      {
        body: JSON.stringify({
          categoryName: "walks",
          projectName: "pet-vlog",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const target = createProjectTargetResponseSchema.parse(
      await targetResponse.json(),
    );

    // When: desktop creates a Key for its dedicated material directory.
    const response = await app.request(
      "http://localhost/api/v1/project-upload-keys",
      {
        body: JSON.stringify({ directoryName: "傍晚散步", target }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    // Then: the raw capability is returned exactly once with the directory name H5 must display.
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      rawKey: expect.stringMatching(/^jyup1\./),
      uploadKey: {
        directoryName: "傍晚散步",
        state: "active",
        target,
      },
    });
  });

  test("lists persisted project targets so a later desktop session can issue another Key", async () => {
    // Given: a previously created project/category target.
    const library = await createTestLibrary();
    const app = createApp({ materialLibrary: library });
    await app.request("http://localhost/api/v1/project-targets", {
      body: JSON.stringify({
        categoryName: "walks",
        projectName: "pet-vlog",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // When: the desktop Web reloads its local target list.
    const response = await app.request(
      "http://localhost/api/v1/project-targets",
    );

    // Then: it receives durable display names with their immutable target IDs.
    expect(response.status).toBe(200);
    expect(
      listProjectTargetsResponseSchema.parse(await response.json()),
    ).toEqual([
      expect.objectContaining({
        categoryName: "walks",
        projectName: "pet-vlog",
      }),
    ]);
  });

  test("reports the material-volume capacity and active upload reservations", async () => {
    // Given: a library with one staged upload reserving space on the configured material volume.
    const library = await createTestLibrary();
    const app = createApp({ materialLibrary: library });
    const target = library.createProjectTarget({
      categoryName: "walks",
      projectName: "pet-vlog",
    });
    await library.createUpload({
      expectedSha256:
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      expectedSizeBytes: 42n,
      fileName: "pet.mov",
      target,
    });

    // When: the desktop requests the current volume state.
    const response = await app.request(
      "http://localhost/api/v1/storage-status",
    );

    // Then: it gets bytes as lossless decimal strings, including staged reservations.
    expect(response.status).toBe(200);
    expect(storageStatusResponseSchema.parse(await response.json())).toEqual({
      availableBytes: "1000000000000000",
      reservedBytes: "42",
    });
  });

  test("rejects malformed upload requests at the Zod boundary", async () => {
    // Given: a local HTTP control plane.
    const library = await createTestLibrary();
    const app = createApp({ materialLibrary: library });

    // When: a client submits a non-decimal expected size.
    const response = await app.request("http://localhost/api/v1/uploads", {
      body: JSON.stringify({ expectedSizeBytes: "one" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then: parsing fails before any file-system or database mutation.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  test("returns only mobile transfer credentials after the local signaling route is ready", async () => {
    // Given: a paired device request and a service that has already opened the Mac WSS route.
    const library = await createTestLibrary();
    const transferService = new FakeUploadTransferService();
    const app = createApp({ materialLibrary: library, transferService });

    // When: the local Web UI asks to send a staged upload to that paired phone.
    const response = await app.request(
      "http://localhost/api/v1/transfer-sessions",
      {
        body: JSON.stringify({
          deviceId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
          uploadId: "3ccf1c18-f4c3-4a0d-af42-311eeef3b3a9",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    // Then: the response exposes the mobile capability but never the Mac signaling token.
    const created = createTransferSessionResponseSchema.parse(
      await response.json(),
    );
    expect(response.status).toBe(201);
    expect(created).toEqual({
      expiresAtEpochMs: 61_000,
      mobileSignalingToken: "mobile-token",
      sessionId: webRtcSessionIdSchema.parse(
        "cc6429b6-0e8b-4b6e-9c5a-0c8eca442703",
      ),
      transferGrant: "transfer-grant",
    });
    expect(transferService.request).toEqual({
      deviceId: deviceIdSchema.parse("2ee77da2-3d07-4d91-b290-f2c560ae046d"),
      uploadId: "3ccf1c18-f4c3-4a0d-af42-311eeef3b3a9",
    });
  });

  test("returns a typed forbidden response before an unpaired device gets transfer credentials", async () => {
    // Given: a local transfer service that rejects an unknown device before peer allocation.
    const library = await createTestLibrary();
    const transferService = new FakeUploadTransferService();
    transferService.createError = new UploadSessionCoordinatorError(
      "DEVICE_NOT_PAIRED",
    );
    const app = createApp({ materialLibrary: library, transferService });

    // When: the local UI asks to create the externally routable transfer session.
    const response = await app.request(
      "http://localhost/api/v1/transfer-sessions",
      {
        body: JSON.stringify({
          deviceId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
          uploadId: "3ccf1c18-f4c3-4a0d-af42-311eeef3b3a9",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    // Then: the UI can instruct the user to pair, without exposing a partial credential.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_NOT_PAIRED",
      message: "The requested mobile device is not paired",
    });
  });
});

class FakeUploadTransferService implements UploadTransferService {
  createError: Error | undefined;
  request:
    | {
        readonly deviceId: ReturnType<typeof deviceIdSchema.parse>;
        readonly uploadId: string;
      }
    | undefined;

  close(): void {}

  async create(input: {
    readonly deviceId: ReturnType<typeof deviceIdSchema.parse>;
    readonly uploadId: string;
  }) {
    if (this.createError !== undefined) {
      throw this.createError;
    }
    this.request = input;
    return {
      expiresAtEpochMs: 61_000,
      iceServers: [],
      macSignalingToken: "mac-token",
      mobileSignalingToken: "mobile-token",
      sessionId: webRtcSessionIdSchema.parse(
        "cc6429b6-0e8b-4b6e-9c5a-0c8eca442703",
      ),
      transferGrant: "transfer-grant",
    };
  }
}

async function createTestLibrary(): Promise<MaterialLibrary> {
  const directory = await mkdtemp(
    join(tmpdir(), "jianying-http-control-plane-"),
  );
  temporaryDirectories.push(directory);
  return createMaterialLibrary({
    availableBytes: async () => 1_000_000_000_000_000n,
    databasePath: join(directory, "state.sqlite"),
    materialRootPath: join(directory, "materials"),
    projectUploadNodeId: "test_upload_node_id_01",
    projectUploadKeyPepper: "test-project-upload-key-pepper",
  });
}
