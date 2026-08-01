import { describe, expect, test } from "vitest";

import { parseNativeTransferNotice } from "./native-transfer-notice";

describe("native transfer notices", () => {
  test("rejects a retired paid-relay outcome", () => {
    // Given: a stale native shell emits an obsolete terminal outcome.
    const payload = {
      outcome: { kind: "obsolete_terminal_outcome", upload_id: "upload-123" },
      session_id: "00000000-0000-4000-8000-000000000001",
    };

    // When: the webview consumes the stale payload.
    const notice = parseNativeTransferNotice(payload);

    // Then: current clients ignore it rather than presenting an obsolete policy.
    expect(notice).toBeUndefined();
  });

  test("ignores a terminal event that has no bound local upload", () => {
    expect(
      parseNativeTransferNotice({
        outcome: {
          kind: "unbound_session",
          session_id: "00000000-0000-4000-8000-000000000002",
        },
        session_id: "00000000-0000-4000-8000-000000000002",
      }),
    ).toBeUndefined();
  });
});
