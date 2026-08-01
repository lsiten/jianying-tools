export type MobileUploadStatus =
  | "awaiting_file"
  | "awaiting_key"
  | "completed"
  | "failed"
  | "hashing"
  | "negotiating"
  | "queued"
  | "transferring";

export type MobileUploadItem = {
  readonly directoryName: string;
  readonly fileName: string;
  readonly id: string;
  readonly progressBytes: number;
  readonly sizeBytes: number;
  readonly status: MobileUploadStatus;
  readonly statusDetail: string;
};

export type MobileUploadUpdate = Partial<
  Omit<MobileUploadItem, "id" | "fileName" | "sizeBytes">
>;

export function mobileUploadErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case "WebRtcFileTransferError":
        if (error.message.includes("SIGNALING_INVALID")) {
          return "本机返回的 ICE 配置无效，无法建立连接";
        }
        return "连接失败，请确认这台 Mac 在线并更换网络后重试";
      case "MobileStateError":
        return "浏览器无法保存安全设备身份；请启用网站数据并使用支持 Ed25519 的新版浏览器";
      case "MobileUploadTransferError":
        return error.message.includes("FILE_DOES_NOT_MATCH")
          ? "所选文件与待恢复的素材不一致，请选择原文件"
          : "恢复会话已失效，请重新选择文件后再上传";
      case "CameraRecordingError":
        return error.message.includes("CAMERA_UNAVAILABLE")
          ? "无法启动摄像头，请确认已允许相机和麦克风权限"
          : "录制未生成可上传的视频，请重新录制";
      default:
        return "请求未完成，请确认这台 Mac 在线后重试";
    }
  }
  return "请求未完成，请稍后重试";
}
