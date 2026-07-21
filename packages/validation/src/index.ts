import { z } from "zod";

export const uploadTypeSchema = z.enum(["image", "video", "audio", "document"]);
export const clientTypeSchema = z.enum(["web", "pwa", "expo-apk"]);
export const userRoleSchema = z.enum(["customer", "admin", "super_admin", "technician"]);
export const uploadStatusSchema = z.enum([
  "local_pending", "queued", "uploading", "sending", "sent",
  "delivered", "seen", "failed", "cancelled",
]);

export const createUploadRequestSchema = z.object({
  uploadId: z.string().uuid(),
  clientMessageId: z.string().min(1),
  roomId: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().positive(),
  originalName: z.string().min(1).max(512),
  messageType: uploadTypeSchema,
  clientType: clientTypeSchema.optional(),
});

export const finalizeUploadRequestSchema = z.object({
  uploadId: z.string().uuid(),
  clientMessageId: z.string().min(1),
  roomId: z.string().min(1),
  storagePath: z.string().min(1),
  messageType: uploadTypeSchema,
  text: z.string().max(10000).optional(),
  metadata: z.object({
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    durationMs: z.number().optional(),
  }).optional(),
});

export const registerDeviceRequestSchema = z.object({
  token: z.string().min(1),
  platform: z.string().min(1),
  appType: clientTypeSchema,
  deviceId: z.string().min(1),
  permission: z.enum(["granted", "denied", "unknown"]),
  appVersion: z.string().optional(),
  deviceName: z.string().optional(),
  role: userRoleSchema.optional(),
  displayName: z.string().optional(),
  operatingSystem: z.string().optional(),
});

export const notificationPayloadSchema = z.object({
  notificationId: z.string().min(1),
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  route: z.string(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  roomId: z.string().optional(),
  userId: z.string().optional(),
});

export const clientMessageIdSchema = z.string().min(1).max(128);
export const roomIdSchema = z.string().min(1).max(128);

export function validateClientMessageId(id: string): boolean {
  return clientMessageIdSchema.safeParse(id).success;
}

export function validateRoomId(id: string): boolean {
  return roomIdSchema.safeParse(id).success;
}
