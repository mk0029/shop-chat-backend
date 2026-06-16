import type { MessageDoc } from "../models/Message";
import type { RoomDoc } from "../models/Room";
import type { ShopUser } from "../types/auth";
import { processNotificationEvent } from "./notificationCenter";

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
  try {
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
    if (!targetUserIds.length) return;

    await processNotificationEvent({
      eventId: `chat.message.created.${String(message._id)}`,
      eventType: "chat.message.created",
      actorUserId: sender.id,
      userIds: targetUserIds,
      title: isCustomerSender ? `Message from ${message.senderName || sender.name || "Customer"}` : "New message from support",
      body: messagePreview(String(message.text || ""), String(message.type || "text")),
      data: {
        event: "chat-message-created",
        route: isCustomerSender ? "/admin/chat" : "/customer/chat",
        route_path: isCustomerSender ? "/admin/chat" : "/customer/chat",
        roomId: String(room._id),
        customerId,
        messageId: String(message._id),
        senderId: sender.id,
        senderName: String(message.senderName || sender.name || ""),
        preview: messagePreview(String(message.text || ""), String(message.type || "text")),
      },
    });
  } catch (error) {
    console.warn("[notifications] chat.message.created failed", error instanceof Error ? error.message : error);
  }
}
