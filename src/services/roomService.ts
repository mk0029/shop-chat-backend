import mongoose from "mongoose";
import { Room, type RoomDoc } from "../models/Room";
import { Message, type MessageDoc } from "../models/Message";
import type { ShopUser } from "../types/auth";
import { getCustomerById, isAdmin, listAdminParticipants } from "./shopAuth";
import { deleteFiles, extractFilePathsFromMessage } from "./storageService";

function chatRoleFor(user: ShopUser) {
  return user.role === "super_admin" ? "admin" : user.role;
}

export function serializeRoom(room: any) {
  const unreadByRaw = room.unreadBy instanceof Map ? Object.fromEntries(room.unreadBy) : room.unreadBy || {};
  return {
    roomId: String(room._id),
    customerId: String(room.customerId),
    customerKey: room.customerKey || null,
    customerName: room.customerName,
    admins: room.admins || [],
    participants: room.participants || [],
    lastMessage: room.lastMessage || null,
    unreadBy: unreadByRaw,
    createdAt: room.createdAt?.toISOString?.() || room.createdAt,
    updatedAt: room.updatedAt?.toISOString?.() || room.updatedAt,
  };
}

export function serializeMessage(message: any) {
  return {
    messageId: String(message._id),
    roomId: String(message.roomId),
    clientMessageId: message.clientMessageId || null,
    type: message.type || "text",
    text: message.text || "",
    attachments: message.attachments || [],
    media: message.media || null,
    senderId: message.senderId,
    senderRole: message.senderRole,
    senderName: message.senderName,
    status: message.status || "sent",
    deliveredTo: message.deliveredTo || [],
    readBy: message.readBy || [],
    replyTo: message.replyTo || null,
    forwarded: Boolean(message.forwarded),
    forwardedFrom: message.forwardedFrom || null,
    messageKind: message.messageKind || "user",
    systemEventType: message.systemEventType || null,
    systemEventData: message.systemEventData || null,
    reactions: message.reactions || [],
    editedAt: message.editedAt?.toISOString?.() || message.editedAt || null,
    deletedAt: message.deletedAt?.toISOString?.() || message.deletedAt || null,
    createdAt: message.createdAt?.toISOString?.() || message.createdAt,
    updatedAt: message.updatedAt?.toISOString?.() || message.updatedAt,
  };
}

export async function getOrCreateRoomForCustomer(customer: ShopUser): Promise<RoomDoc> {
  const admins = await listAdminParticipants();
  const participants = [
    { userId: customer.id, role: "customer", name: customer.name },
    ...admins.filter((admin) => admin.userId !== customer.id),
  ];

  const room = await Room.findOneAndUpdate(
    { customerId: customer.id },
    {
      $setOnInsert: {
        customerId: customer.id,
        unreadBy: {},
      },
      $set: {
        customerName: customer.name,
        customerKey: customer.customerId || "",
        admins,
        participants,
      },
    },
    { new: true, upsert: true },
  );

  return room as RoomDoc;
}

export async function refreshRoomSupportRoster(room: RoomDoc): Promise<RoomDoc> {
  const admins = await listAdminParticipants();
  const participants = [
    { userId: String((room as any).customerId), role: "customer", name: String((room as any).customerName || "Customer") },
    ...admins.filter((admin) => admin.userId !== String((room as any).customerId)),
  ];
  const sameParticipants = JSON.stringify((room as any).participants || []) === JSON.stringify(participants);
  const sameAdmins = JSON.stringify((room as any).admins || []) === JSON.stringify(admins);
  (room as any).admins = admins;
  (room as any).participants = participants;
  if (!sameParticipants || !sameAdmins) {
    await Room.updateOne(
      { _id: (room as any)._id },
      { $set: { admins, participants } },
      { timestamps: false },
    );
  }
  return room;
}

export async function getOrCreateRoomByCustomerId(customerId: string) {
  const customer = await getCustomerById(customerId);
  if (!customer) return null;
  return getOrCreateRoomForCustomer(customer);
}

export async function assertRoomAccess(user: ShopUser, roomId: string) {
  if (!mongoose.Types.ObjectId.isValid(roomId)) return null;
  const room = await Room.findById(roomId);
  if (!room) return null;
  if (isAdmin(user)) return room as RoomDoc;
  if (user.role === "customer" && String((room as any).customerId) === String(user.id)) return room as RoomDoc;
  return null;
}

export async function createMessage(params: {
  room: RoomDoc;
  sender: ShopUser;
  text: string;
  type?: "text" | "image" | "video" | "audio" | "file";
  attachments?: unknown[];
  media?: Record<string, unknown> | null;
  replyTo?: { messageId: string; text: string; senderId: string; senderName?: string } | null;
  clientMessageId?: string;
  forwarded?: boolean;
  forwardedFrom?: string | null;
  messageKind?: "user" | "system";
  systemEventType?: string | null;
  systemEventData?: Record<string, unknown> | null;
}) {
  const text = params.text.trim();
  const messageKind = params.messageKind || "user";
  const systemEvent = messageKind === "system";
  const senderId = systemEvent ? "system" : params.sender.id;
  const senderRole = systemEvent ? "admin" : chatRoleFor(params.sender);
  const senderName = systemEvent ? "System" : params.sender.name;

  if (params.clientMessageId) {
    const existing = await Message.findOne({
      roomId: params.room._id,
      clientMessageId: params.clientMessageId,
    });
    if (existing) return existing as MessageDoc;
  }

  let message: MessageDoc;
  try {
    message = (await Message.create({
      roomId: params.room._id,
      clientMessageId: params.clientMessageId || undefined,
      type: params.type || "text",
      text,
      attachments: params.attachments || [],
      media: params.media || null,
      senderId,
      senderRole,
      senderName,
      status: "sent",
      deliveredTo: [{ userId: senderId, role: senderRole, name: senderName, at: new Date() }],
      readBy: [{ userId: senderId, role: senderRole, name: senderName, at: new Date() }],
      replyTo: params.replyTo || null,
      forwarded: Boolean(params.forwarded),
      forwardedFrom: params.forwardedFrom || null,
      messageKind,
      systemEventType: params.systemEventType || null,
      systemEventData: params.systemEventData || null,
    })) as MessageDoc;
  } catch (error: any) {
    if (params.clientMessageId && error?.code === 11000) {
      const existing = await Message.findOne({
        roomId: params.room._id,
        clientMessageId: params.clientMessageId,
      });
      if (existing) return existing as MessageDoc;
    }
    throw error;
  }

  const unreadBy: Record<string, number> = {};
  for (const participant of (params.room as any).participants || []) {
    const userId = String(participant.userId);
    if (userId !== senderId) {
      unreadBy[`unreadBy.${userId}`] = 1;
    }
  }

  await Room.updateOne(
    { _id: params.room._id },
    {
      $set: {
        lastMessage: {
          messageId: String(message._id),
          text,
          type: params.type || "text",
          senderId,
          senderRole,
          senderName,
          systemEventType: params.systemEventType || null,
          systemEventData: params.systemEventData || null,
          createdAt: (message as any).createdAt || new Date(),
        },
      },
      $inc: unreadBy,
    },
  );

  return message as MessageDoc;
}

export async function editMessage(messageId: string, user: ShopUser, text: string) {
  if (!mongoose.Types.ObjectId.isValid(messageId)) return null;
  const message = await Message.findById(messageId);
  if (!message) return null;
  const room = await assertRoomAccess(user, String(message.roomId));
  if (!room) return null;
  if (String((message as any).senderId) !== user.id) {
    throw new Error("Only the sender can edit this message");
  }
  if ((message as any).deletedAt) {
    throw new Error("Deleted messages cannot be edited");
  }
  (message as any).text = text.trim();
  (message as any).editedAt = new Date();
  await message.save();
  await Room.updateOne(
    { _id: room._id, "lastMessage.messageId": String(message._id) },
    {
      $set: {
        "lastMessage.text": (message as any).text,
        "lastMessage.type": (message as any).type || "text",
      },
    },
  );
  return { room, message };
}

export async function deleteMessage(messageId: string, user: ShopUser, scope: "me" | "everyone") {
  if (!mongoose.Types.ObjectId.isValid(messageId)) return null;
  const message = await Message.findById(messageId);
  if (!message) return null;
  const room = await assertRoomAccess(user, String(message.roomId));
  if (!room) return null;

  if (scope === "me" && String((message as any).senderId) !== user.id) {
    await Message.updateOne({ _id: message._id }, { $addToSet: { hiddenFor: user.id } });
    return { room, message, localOnly: true };
  }

  if (String((message as any).senderId) !== user.id) {
    throw new Error("Only the sender can delete this message for everyone");
  }

  const filePaths = extractFilePathsFromMessage(message);
  (message as any).text = "This message was deleted";
  (message as any).attachments = [];
  (message as any).media = null;
  (message as any).deletedAt = new Date();
  await message.save();
  if (filePaths.length) {
    void deleteFiles(filePaths);
  }
  await Room.updateOne(
    { _id: room._id, "lastMessage.messageId": String(message._id) },
    {
      $set: {
        "lastMessage.text": "This message was deleted",
        "lastMessage.type": "text",
      },
    },
  );
  return { room, message, localOnly: false };
}

export async function clearRoomMessagesForEveryone(room: RoomDoc, user: ShopUser) {
  const now = new Date();
  const allMessages = await Message.find({ roomId: room._id }).lean();
  const allPaths = allMessages.flatMap((msg) => extractFilePathsFromMessage(msg));
  await Message.deleteMany({ roomId: room._id });
  await Room.updateOne({ _id: room._id }, { $set: { unreadBy: {} } });
  if (allPaths.length) {
    void deleteFiles(allPaths);
  }

  const message = await createMessage({
    room,
    sender: user,
    text: "Chat cleared by admin",
    type: "text",
    messageKind: "system",
    systemEventType: "chat_cleared",
    systemEventData: {
      eventType: "chat_cleared",
      clearedById: user.id,
      clearedByName: user.name,
      clearedByRole: user.role,
      clearedAt: now.toISOString(),
    },
  });

  await Room.updateOne({ _id: room._id }, { $set: { [`unreadBy.${user.id}`]: 0 } });
  return { room, message };
}

export async function reactToMessage(messageId: string, user: ShopUser, emoji: string | null) {
  if (!mongoose.Types.ObjectId.isValid(messageId)) return null;
  const message = await Message.findById(messageId);
  if (!message) return null;
  const room = await assertRoomAccess(user, String(message.roomId));
  if (!room) return null;
  await Message.updateOne({ _id: message._id }, { $pull: { reactions: { userId: user.id } } });
  if (emoji) {
    await Message.updateOne(
      { _id: message._id },
      { $push: { reactions: { userId: user.id, userName: user.name, emoji, timestamp: new Date() } } },
    );
  }
  const updated = await Message.findById(message._id);
  return { room, message: updated };
}

export async function markDelivered(messageIds: string[], user: ShopUser) {
  const validIds = messageIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!validIds.length) return [];
  await Message.updateMany(
    {
      _id: { $in: validIds },
      senderId: { $ne: user.id },
      "deliveredTo.userId": { $ne: user.id },
    },
    {
      $push: { deliveredTo: { userId: user.id, role: chatRoleFor(user), name: user.name, at: new Date() } },
      $set: { status: "delivered" },
    },
  );
  const messages = await Message.find({ _id: { $in: validIds } });
  return messages.map(serializeMessage);
}

export async function markRoomRead(room: RoomDoc, user: ShopUser, messageIds?: string[]) {
  const validMessageIds = messageIds?.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const filter: any = {
    roomId: room._id,
    senderId: { $ne: user.id },
    "readBy.userId": { $ne: user.id },
  };
  if (validMessageIds?.length) filter._id = { $in: validMessageIds };

  await Message.updateMany(filter, {
    $addToSet: {
      readBy: { userId: user.id, role: chatRoleFor(user), name: user.name, at: new Date() },
      deliveredTo: { userId: user.id, role: chatRoleFor(user), name: user.name, at: new Date() },
    },
    $set: { status: "read" },
  });
  await Room.updateOne({ _id: room._id }, { $set: { [`unreadBy.${user.id}`]: 0 } });
  const messages = validMessageIds?.length
    ? await Message.find({ _id: { $in: validMessageIds } })
    : await Message.find({ roomId: room._id });
  return messages.map(serializeMessage);
}
