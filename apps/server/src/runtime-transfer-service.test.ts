import { describe, expect, test } from "vitest";

import { createRuntimeTransferService } from "./runtime-transfer-service.js";

describe("runtime transfer service", () => {
  test("does not construct WebRTC or a Worker socket when external signaling is disabled", () => {
    // Given: a local-only server configuration.
    // When: startup resolves its transfer-service dependency.
    const service = createRuntimeTransferService({
      onError: () => undefined,
      signaling: { kind: "disabled" },
    });

    // Then: the HTTP surface can report its unavailable public-transfer capability safely.
    expect(service).toBeUndefined();
  });
});
