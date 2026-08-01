import { z } from "zod";

import { decimalBytesSchema } from "./http.js";
import { deviceIdSchema, materialIdSchema, uploadIdSchema } from "./ids.js";

export const DATA_CHUNK_HEADER_BYTES = 48;

export const DATA_CHUNK_PACKET_ERROR_REASONS = {
  CHECKSUM_INVALID: "CHECKSUM_INVALID",
  CHUNK_INDEX_INVALID: "CHUNK_INDEX_INVALID",
  FRAME_TOO_SHORT: "FRAME_TOO_SHORT",
  OFFSET_INVALID: "OFFSET_INVALID",
  PAYLOAD_EMPTY: "PAYLOAD_EMPTY",
} as const;

export type DataChunkPacketErrorReason =
  (typeof DATA_CHUNK_PACKET_ERROR_REASONS)[keyof typeof DATA_CHUNK_PACKET_ERROR_REASONS];

export class DataChunkPacketError extends Error {
  readonly name = "DataChunkPacketError";

  constructor(readonly reason: DataChunkPacketErrorReason) {
    super(`Invalid WebRTC data chunk packet: ${reason}`);
  }
}

export type DataChunkPacket = {
  readonly checksumSha256: string;
  readonly chunkIndex: bigint;
  readonly offsetBytes: bigint;
  readonly payload: Uint8Array;
};

export const TRANSFER_CONTROL_MESSAGE_TYPES = {
  ACK: "ack",
  AUTHORIZE: "authorize",
  CANCEL: "cancel",
  COMPLETE: "complete",
  NACK: "nack",
  PAUSE: "pause",
  READY: "ready",
  RESUME: "resume",
} as const;

export const transferControlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    deviceId: deviceIdSchema,
    deviceProof: z.string().min(1),
    dtlsFingerprint: z.string().min(1),
    grant: z.string().min(1),
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.AUTHORIZE),
    uploadId: uploadIdSchema,
  }),
  z.object({
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.RESUME),
    uploadId: uploadIdSchema,
  }),
  z.object({
    ackEpoch: decimalBytesSchema,
    receivedBytes: decimalBytesSchema,
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.ACK),
    uploadId: uploadIdSchema,
  }),
  z.object({
    code: z.string().min(1),
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.NACK),
    uploadId: uploadIdSchema,
  }),
  z.object({
    reason: z.string().min(1),
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.PAUSE),
    uploadId: uploadIdSchema,
  }),
  z.object({
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.CANCEL),
    uploadId: uploadIdSchema,
  }),
  z.object({
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.COMPLETE),
    uploadId: uploadIdSchema,
  }),
  z.object({
    materialId: materialIdSchema,
    type: z.literal(TRANSFER_CONTROL_MESSAGE_TYPES.READY),
    uploadId: uploadIdSchema,
  }),
]);

export type TransferControlMessage = z.infer<
  typeof transferControlMessageSchema
>;

/** Decodes one bounded binary DataChannel message without imposing a file or batch limit. */
export function decodeDataChunkPacket(input: Uint8Array): DataChunkPacket {
  if (input.byteLength < DATA_CHUNK_HEADER_BYTES) {
    throw new DataChunkPacketError("FRAME_TOO_SHORT");
  }

  const chunkIndex = readUint64(input, 0);
  const offsetBytes = readUint64(input, 8);
  const checksumSha256 = bytesToHex(
    input.subarray(16, DATA_CHUNK_HEADER_BYTES),
  );
  const payload = input.subarray(DATA_CHUNK_HEADER_BYTES);
  if (payload.byteLength === 0) {
    throw new DataChunkPacketError("PAYLOAD_EMPTY");
  }

  return { checksumSha256, chunkIndex, offsetBytes, payload };
}

/** Encodes a bounded binary DataChannel message; the caller selects chunk size from runtime backpressure. */
export function encodeDataChunkPacket(input: DataChunkPacket): Uint8Array {
  validatePacket(input);
  const frame = new Uint8Array(
    DATA_CHUNK_HEADER_BYTES + input.payload.byteLength,
  );
  writeUint64(frame, 0, input.chunkIndex);
  writeUint64(frame, 8, input.offsetBytes);
  writeHex(frame, 16, input.checksumSha256);
  frame.set(input.payload, DATA_CHUNK_HEADER_BYTES);
  return frame;
}

function validatePacket(input: DataChunkPacket): void {
  if (input.chunkIndex < 0n || input.chunkIndex > 0xffff_ffff_ffff_ffffn) {
    throw new DataChunkPacketError("CHUNK_INDEX_INVALID");
  }
  if (input.offsetBytes < 0n || input.offsetBytes > 0xffff_ffff_ffff_ffffn) {
    throw new DataChunkPacketError("OFFSET_INVALID");
  }
  if (!/^[a-f0-9]{64}$/.test(input.checksumSha256)) {
    throw new DataChunkPacketError("CHECKSUM_INVALID");
  }
  if (input.payload.byteLength === 0) {
    throw new DataChunkPacketError("PAYLOAD_EMPTY");
  }
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = offset; index < offset + 8; index += 1) {
    value = value * 256n + BigInt(byteAt(bytes, index));
  }
  return value;
}

function writeUint64(bytes: Uint8Array, offset: number, value: bigint): void {
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(value % 256n);
    value /= 256n;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function writeHex(
  destination: Uint8Array,
  offset: number,
  value: string,
): void {
  for (let index = 0; index < 32; index += 1) {
    const byteStart = index * 2;
    destination[offset + index] = Number.parseInt(
      value.slice(byteStart, byteStart + 2),
      16,
    );
  }
}

function byteAt(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined) {
    throw new DataChunkPacketError("FRAME_TOO_SHORT");
  }
  return byte;
}
