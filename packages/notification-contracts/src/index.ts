export interface RegisterDeviceRequest {
  token: string;
  platform: string;
  appType: "browser" | "pwa" | "expo-apk";
  deviceId: string;
  permission: "granted" | "denied" | "unknown";
  appVersion?: string;
  deviceName?: string;
  role?: string;
  displayName?: string;
  operatingSystem?: string;
  browserName?: string;
}

export interface RegisterDeviceResponse {
  success: boolean;
  deviceId?: string;
  token?: string;
}

export interface UnregisterDeviceRequest {
  userId?: string;
  token: string;
}

export interface UnregisterDeviceResponse {
  success: boolean;
}

export interface NotificationEvent {
  notificationId: string;
  eventId: string;
  eventType: string;
  title: string;
  body: string;
  route?: string;
  entityType?: string;
  entityId?: string;
  roomId?: string;
  userId?: string;
  priority?: "normal" | "high";
  channelId?: string;
}

export interface SendNotificationRequest {
  eventType: string;
  eventId: string;
  actorUserId?: string;
  userId?: string;
  userIds?: string[];
  audience?: "admins" | "all" | "customers";
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

export type AppType = "browser" | "pwa" | "expo-apk";
