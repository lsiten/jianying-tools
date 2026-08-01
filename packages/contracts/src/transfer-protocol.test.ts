import { describe, expect, test } from "vitest";

import {
  decodeDataChunkPacket,
  encodeDataChunkPacket,
} from "./transfer-protocol.js";

describe("WebRTC data-channel packet protocol", () => {
  test("round-trips a chunk whose offset exceeds JavaScript safe integer range", () => {
    // Given: a valid packet at a 64-bit byte offset, without a file-size product limit.
    const source = {
      checksumSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      chunkIndex: 4_294_967_296n,
      offsetBytes: 1_234_567_890_123_456_789n,
      payload: new TextEncoder().encode("hello"),
    };

    // When: the binary packet crosses a reliable ordered DataChannel.
    const decoded = decodeDataChunkPacket(encodeDataChunkPacket(source));

    // Then: all addressing and integrity fields retain their exact value.
    expect(decoded).toMatchObject(source);
    expect(new TextDecoder().decode(decoded.payload)).toBe("hello");
  });

  test("rejects a frame shorter than the fixed header", () => {
    // Given: a truncated DataChannel binary message.
    const packet = new Uint8Array(43);

    // When: the receiver attempts to parse it at the protocol boundary.
    let thrown: unknown;
    try {
      decodeDataChunkPacket(packet);
    } catch (error) {
      thrown = error;
    }

    // Then: it cannot reach durable storage or acknowledgement processing.
    expect(thrown).toMatchObject({
      name: "DataChunkPacketError",
      reason: "FRAME_TOO_SHORT",
    });
  });
});
