import type { ResumableMobileUpload } from "./mobile-state.js";
import type { MobileUploadItem } from "./mobile-upload-item.js";

export function browserDisplayName(): string {
  return navigator.userAgent.includes("iPhone")
    ? "iPhone 浏览器"
    : "手机浏览器";
}

export function mobileWorkerBaseUrl(): string {
  return import.meta.env.VITE_SIGNALING_WORKER_URL || window.location.origin;
}

export function resumableUploadItem(
  upload: ResumableMobileUpload,
): MobileUploadItem {
  return {
    directoryName: upload.directoryName,
    fileName: upload.fileName,
    id: upload.uploadId,
    progressBytes: 0,
    sizeBytes: upload.sizeBytes,
    status: "awaiting_file",
    statusDetail: "请选择同一文件，校验后从已确认位置继续传输",
  };
}
