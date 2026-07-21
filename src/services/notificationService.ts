import type { MessageDoc } from "../models/Message";
import type { RoomDoc } from "../models/Room";
import type { ShopUser } from "../types/auth";
import { dispatchNotificationBackground } from "./notificationDispatcher";
import { notificationLogger } from "../lib/notificationLogger";

function messagePreview(text: string, type?: string) {
  if (type === "text") {
    const preview = String(text || "").trim().replace(/\s+/g, " ");
    return preview ? preview.slice(0, 140) : "New message";
  }
  return `Sent a ${type === "file" ? "file" : type || "message"}`;
}

export function notifyChatMessageCreated(input: {
  room: RoomDoc;
  message: MessageDoc;
  sender: ShopUser;
}) {
  try {
    const room = input.room as any;
    const message = input.message as any;
    const sender = input.sender;
    const isCustomerSender = sender.role === "customer";
    const isSystemMessage = message.messageKind === "system";
    const adminIds = Array.from(
      new Set(
        ((room.admins || []) as Array<{ userId?: string }>)
          .map((admin) => String(admin.userId || "").trim())
          .filter((id) => id && id !== sender.id),
      ),
    );
    const customerId = String(room.customerId || "").trim();
    const supportToCustomerIds = customerId && customerId !== sender.id ? [customerId] : [];
    const targetUserIds = isSystemMessage
      ? supportToCustomerIds
      : isCustomerSender
        ? adminIds
        : supportToCustomerIds;
    if (!targetUserIds.length) return;

    const eventId = `chat.message.created.${String(message._id)}`;
    notificationLogger.eventCreated(eventId, "chat.message.created", {
      roomId: String(room._id),
      senderId: sender.id,
      targetCount: targetUserIds.length,
    });

    dispatchNotificationBackground({
      eventId,
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
    notificationLogger.notificationFailed(
      `chat.message.created.${String((input.message as any)?._id || "unknown")}`,
      "unknown",
      error instanceof Error ? error.message : String(error),
    );
  }
}
