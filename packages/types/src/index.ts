export type AppRuntime = "web-browser" | "pwa" | "android-native-wrapper";

export type UserRole = "customer" | "admin" | "super_admin" | "technician";

export type UploadStatus =
  | "local_pending"
  | "queued"
  | "uploading"
  | "sending"
  | "sent"
  | "delivered"
  | "seen"
  | "failed"
  | "cancelled";

export type MessageStatus = UploadStatus;

export type UploadType = "image" | "video" | "audio" | "document";

export type ClientType = "web" | "pwa" | "expo-apk";

export interface IdempotencyKey {
  value: string;
  userId: string;
  resource: string;
}

export interface NotificationDevice {
  userId: string;
  deviceId: string;
  token: string;
  platform: "web" | "android";
  appType: "browser" | "pwa" | "expo-apk";
  permission: "granted" | "denied" | "unknown";
  role: UserRole;
  enabled: boolean;
  appVersion?: string;
  browserName?: string;
  operatingSystem?: string;
  lastSeenAt: Date;
  lastRegisteredAt: Date;
  failureCount: number;
  lastFailureAt?: Date;
}

export interface NotificationPayload {
  notificationId: string;
  eventId: string;
  eventType: string;
  title: string;
  body: string;
  route: string;
  entityType?: string;
  entityId?: string;
  roomId?: string;
  userId?: string;
}

export interface UploadProgress {
  uploadId: string;
  localMessageId: string;
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  status: string;
}

export interface SignedUploadResponse {
  signedUrl: string;
  storagePath: string;
  cdnUrl?: string;
  headers?: Record<string, string>;
  expiresAt: number;
}

export interface CreateUploadRequest {
  uploadId: string;
  clientMessageId: string;
  roomId: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  messageType: UploadType;
  clientType: ClientType;
}

export interface FinalizeUploadRequest {
  uploadId: string;
  clientMessageId: string;
  roomId: string;
  storagePath: string;
  messageType: UploadType;
  text?: string;
  metadata?: {
    mimeType?: string;
    sizeBytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
  };
}

export interface RegisterDeviceRequest {
  token: string;
  platform: string;
  appType: ClientType;
  deviceId: string;
  permission: "granted" | "denied" | "unknown";
  appVersion: string;
  deviceName?: string;
  role?: UserRole;
  displayName?: string;
  operatingSystem?: string;
}
