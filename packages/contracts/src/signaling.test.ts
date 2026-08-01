import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { signalingMessageSchema } from "./signaling.js";

describe("signaling message contract", () => {
  test("accepts an ICE candidate without accepting a media payload", () => {
    // Given: a relay message containing only a session-bound ICE candidate.
    const rawMessage = {
      candidate: "candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host",
      mid: "0",
      sessionId: randomUUID(),
      type: "candidate",
    };

    // When: the Cloudflare signaling boundary parses the untrusted WebSocket JSON.
    const message = signalingMessageSchema.parse(rawMessage);

    // Then: only the candidate metadata survives the shared contract.
    expect(message).toEqual(rawMessage);
  });

  test("rejects arbitrary media bytes at the signaling boundary", () => {
    // Given: a malicious attempt to use the signal path as a material transport.
    const rawMessage = {
      bytes: "aGVsbG8=",
      sessionId: randomUUID(),
      type: "media",
    };

    // When: the worker parses that external message.
    const parse = () => signalingMessageSchema.parse(rawMessage);

    // Then: it cannot enter a Durable Object relay room.
    expect(parse).toThrow();
  });

  test("allows typed connection and paid-relay close reasons but rejects an untyped one", () => {
    // Given: two terminal outcomes that must remain distinct to the mobile client.
    const transferCancelled = {
      reason: "TRANSFER_CANCELLED",
      sessionId: randomUUID(),
      type: "close",
    };
    const connectionFailure = {
      reason: "CONNECTION_FAILED",
      sessionId: randomUUID(),
      type: "close",
    };
    const opaqueClose = {
      reason: "please try again later",
      sessionId: randomUUID(),
      type: "close",
    };

    // When: the Cloudflare signaling boundary receives each close message.
    const parseOpaqueClose = () => signalingMessageSchema.parse(opaqueClose);

    // Then: clients can distinguish a connection failure from a cancelled transfer.
    expect(signalingMessageSchema.parse(transferCancelled)).toEqual(
      transferCancelled,
    );
    expect(signalingMessageSchema.parse(connectionFailure)).toEqual(
      connectionFailure,
    );
    expect(parseOpaqueClose).toThrow();
  });
});
