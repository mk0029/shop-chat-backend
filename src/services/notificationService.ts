import { env } from "../config/env";
import type { MessageDoc } from "../models/Message";
import type { RoomDoc } from "../models/Room";
import type { ShopUser } from "../types/auth";

function appBaseUrl() {
  return String(env.notificationApiUrl || env.shopFrontendUrl || "").replace(/\/+$/, "");
}

function messagePreview(text: string, type?: string) {
  if (type === "text") {
    const preview = String(text || "").trim().replace(/\s+/g, " ");
    return preview ? preview.slice(0, 140) : "New message";
  }
  return `Sent a ${type === "file" ? "file" : type || "message"}`;
}

export async function notifyChatMessageCreated(input: {
  room: RoomDoc;
  message: MessageDoc;
  sender: ShopUser;
}) {
  const baseUrl = appBaseUrl();
  if (!baseUrl) return;

  const room = input.room as any;
  const message = input.message as any;
  const sender = input.sender;
  const isCustomerSender = sender.role === "customer";
  const adminIds = Array.from(
    new Set(
      ((room.admins || []) as Array<{ userId?: string }>)
        .map((admin) => String(admin.userId || "").trim())
        .filter((id) => id && id !== sender.id),
    ),
  );
  const customerId = String(room.customerId || "").trim();
  const supportToCustomerIds = customerId && customerId !== sender.id ? [customerId] : [];
  const targetUserIds = isCustomerSender ? adminIds : supportToCustomerIds;
  if (!targetUserIds.length && !isCustomerSender) return;

  const route = isCustomerSender ? "/admin/chat" : "/customer/chat";
  const body = {
    eventId: `chat.message.created.${String(message.messageId || message._id)}`,
    eventType: "chat.message.created",
    actorUserId: sender.id,
    ...(targetUserIds.length ? { userIds: targetUserIds } : { audience: "admins" }),
    title: isCustomerSender ? `Message from ${message.senderName || sender.name || "Customer"}` : "New message from support",
    body: messagePreview(String(message.text || ""), String(message.type || "text")),
    data: {
      event: "chat-message-created",
      route,
      route_path: route,
      roomId: String(room._id),
      customerId,
      messageId: String(message.messageId || message._id),
      senderId: sender.id,
      senderName: String(message.senderName || sender.name || ""),
    },
  };

  await fetch(`${baseUrl}/api/notifications/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.chatSyncToken ? { "x-notify-secret": env.chatSyncToken } : {}),
    },
    body: JSON.stringify(body),
  }).catch((error) => {
    console.warn("[notifications] chat.message.created failed", error);
  });
}
