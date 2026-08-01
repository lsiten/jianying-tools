import { afterEach, describe, expect, test, vi } from "vitest";

import { ControlPlaneError, createControlPlaneApi } from "./control-plane-api";

describe("local control plane API", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("rejects a non-loopback destination before any material metadata can leave the device", () => {
    // Given: a configuration value supplied through the local WebView.

    // When: it attempts to point the control plane at a remote address.
    const createClient = () =>
      createControlPlaneApi("https://untrusted.example");

    // Then: the typed boundary rejects it before it can construct a fetch target.
    expect(createClient).toThrow(ControlPlaneError);
    expect(createClient).toThrow("LOCAL_ENDPOINT_REQUIRED");
  });

  test("creates a directory-scoped Key through the Mac-local endpoint", async () => {
    // Given: the desktop has selected one of its local material targets.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rawKey:
              "jyup1.local_node_1234567890.aee77da2-3d07-4d91-b290-f2c560ae046d.secret",
            uploadKey: {
              directoryName: "傍晚散步",
              keyId: "aee77da2-3d07-4d91-b290-f2c560ae046d",
              state: "active",
              target: {
                categoryId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
                projectId: "3ee77da2-3d07-4d91-b290-f2c560ae046d",
              },
            },
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // When: it asks the local server to issue a Key.
    const created = await createControlPlaneApi(
      "http://127.0.0.1:31887",
    ).createProjectUploadKey({
      directoryName: "傍晚散步",
      target: {
        categoryId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
        projectId: "3ee77da2-3d07-4d91-b290-f2c560ae046d",
      },
    });

    // Then: only the local HTTP endpoint receives the target and the raw Key is returned once.
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/project-upload-keys", "http://127.0.0.1:31887"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(created).toMatchObject({
      rawKey:
        "jyup1.local_node_1234567890.aee77da2-3d07-4d91-b290-f2c560ae046d.secret",
      uploadKey: { directoryName: "傍晚散步" },
    });
  });

  test("loads persisted project targets for a later Key issuance", async () => {
    // Given: the local API returns a target created in an earlier desktop session.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                categoryId: "2ee77da2-3d07-4d91-b290-f2c560ae046d",
                categoryName: "walks",
                projectId: "3ee77da2-3d07-4d91-b290-f2c560ae046d",
                projectName: "pet-vlog",
              },
            ]),
            { status: 200 },
          ),
      ),
    );

    // When: the reloaded desktop requests its targets.
    const targets = await createControlPlaneApi(
      "http://127.0.0.1:31887",
    ).listProjectTargets();

    // Then: the Key form can name the persisted target without recreating it.
    expect(targets).toEqual([
      expect.objectContaining({
        categoryName: "walks",
        projectName: "pet-vlog",
      }),
    ]);
  });

  test("loads lossless capacity data for the local material volume", async () => {
    // Given: the local server reports both free capacity and active upload reservations.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            availableBytes: "1000000000000000",
            reservedBytes: "1048576",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // When: the desktop refreshes its material-volume status.
    const storage = await createControlPlaneApi(
      "http://127.0.0.1:31887",
    ).storageStatus();

    // Then: decimal strings keep large byte counts exact in the Web UI.
    expect(storage).toEqual({
      availableBytes: "1000000000000000",
      reservedBytes: "1048576",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/storage-status", "http://127.0.0.1:31887"),
      expect.objectContaining({ method: "GET" }),
    );
  });
});
