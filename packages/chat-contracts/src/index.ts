export type MessageStatus = "local_pending" | "queued" | "uploading" | "sending" | "sent" | "delivered" | "seen" | "failed" | "cancelled";

export interface ChatMessage {
  messageId: string;
  roomId: string;
  senderId: string;
  clientMessageId?: string;
  messageType: "text" | "image" | "video" | "audio" | "document" | "system";
  text?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  status?: MessageStatus;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageRequest {
  roomId: string;
  clientMessageId: string;
  messageType: ChatMessage["messageType"];
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface SendMessageResponse {
  messageId: string;
  clientMessageId: string;
  status: MessageStatus;
  createdAt: string;
}

export interface RoomInfo {
  roomId: string;
  participants: string[];
  title?: string;
  lastMessage?: ChatMessage;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}
