export interface CreateSignedUploadRequest {
  uploadId: string;
  clientMessageId: string;
  roomId: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  messageType: "image" | "video" | "audio" | "document";
  clientType?: "web" | "pwa" | "expo-apk";
}

export interface CreateSignedUploadResponse {
  uploadId: string;
  signedUrl: string;
  storagePath: string;
  cdnUrl?: string;
  headers?: Record<string, string>;
  expiresAt: number;
}

export interface FinalizeUploadRequest {
  uploadId: string;
  clientMessageId: string;
  roomId: string;
  storagePath: string;
  messageType: "image" | "video" | "audio" | "document";
  text?: string;
  metadata?: {
    mimeType?: string;
    sizeBytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
  };
}

export interface FinalizeUploadResponse {
  message: string;
  messageId: string;
  idempotent: boolean;
  data?: unknown;
}

export interface CancelUploadRequest {
  uploadId: string;
  reason?: string;
}

export interface CancelUploadResponse {
  uploadId: string;
  status: "cancelled";
}

export interface UploadStatusRequest {
  uploadId: string;
}

export interface UploadStatusResponse {
  uploadId: string;
  exists: boolean;
  finalized: boolean;
  messageId: string | null;
  status: "pending" | "completed" | "failed";
}
