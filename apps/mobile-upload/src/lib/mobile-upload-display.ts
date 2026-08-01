import type { MobileUploadStatus } from "./mobile-upload-item";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatUploadBytes(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return unitIndex === 0
    ? `${value} ${BYTE_UNITS[unitIndex]}`
    : `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

export function uploadStatusLabel(status: MobileUploadStatus): string {
  switch (status) {
    case "hashing":
      return "校验中";
    case "queued":
      return "队列中";
    case "negotiating":
      return "连接中";
    case "transferring":
      return "直传中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "awaiting_file":
      return "待续传";
    case "awaiting_key":
      return "等待目录";
  }
}
