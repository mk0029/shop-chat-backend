import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { Message } from "../models/Message";
import { Room } from "../models/Room";
import { requireAdmin, requireCustomer, requireShopAuth, type AuthRequest } from "../middleware/auth";
import {
  assertRoomAccess,
  clearRoomMessagesForEveryone,
  createMessage,
  deleteMessage,
  editMessage,
  getOrCreateRoomByCustomerId,
  getOrCreateRoomForCustomer,
  markDelivered,
  markRoomRead,
  reactToMessage,
  serializeMessage,
  serializeRoom,
  listRoomsForUser,
} from "../services/roomService";
import { getChatNamespace } from "../sockets/chatSocket";
import { notifyChatMessageCreated } from "../services/notificationService";
import { emitSyncEvent, getSyncEventsSince } from "../services/syncEventService";

const router = Router();

function billCreatedEventKey(message: any) {
  const eventType = String(message?.systemEventType || message?.systemEventData?.eventType || "");
  const clientMessageId = String(message?.clientMessageId || "");
  if (eventType !== "bill_created" && !clientMessageId.startsWith("event:bill_created:")) return "";
  const billId = String(message?.systemEventData?.billId || "").trim();
  return billId || clientMessageId.replace("event:bill_created:", "").trim();
}

function dedupeBillCreatedEvents(messages: any[]) {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = billCreatedEventKey(message);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MESSAGE_PROJECTION = {
  roomId: 1, clientMessageId: 1, type: 1, text: 1, attachments: 1,
  media: 1, senderId: 1, senderRole: 1, senderName: 1, status: 1,
  deliveredTo: 1, readBy: 1, replyTo: 1, forwarded: 1, forwardedFrom: 1,
  messageKind: 1, systemEventType: 1, systemEventData: 1,
  reactions: 1, hiddenFor: 1, editedAt: 1, deletedAt: 1,
  createdAt: 1, updatedAt: 1,
};

const ROOM_PROJECTION = {
  customerId: 1, customerKey: 1, customerName: 1,
  admins: 1, participants: 1, lastMessage: 1, unreadBy: 1,
  createdAt: 1, updatedAt: 1,
};

const sendMessageSchema = z.object({
  roomId: z.string(),
  text: z.string().trim().min(0).max(5000),
  type: z.enum(["text", "image", "video", "audio", "file"]).optional(),
  attachments: z.array(z.unknown()).optional(),
  media: z.record(z.unknown()).nullable().optional(),
  clientMessageId: z.string().trim().max(120).optional(),
  replyTo: z.object({ messageId: z.string(), text: z.string(), senderId: z.string(), senderName: z.string().optional() }).nullable().optional(),
});
const editMessageSchema = z.object({ text: z.string().trim().min(1).max(5000) });
const deleteMessageSchema = z.object({ scope: z.enum(["me", "everyone"]).default("everyone") });
const reactMessageSchema = z.object({ emoji: z.string().trim().min(1).max(16).nullable() });
const forwardMessageSchema = z.object({ roomId: z.string() });
const billCreatedEventSchema = z.object({
  customerId: z.string().trim().min(1), billId: z.string().trim().min(1),
  actorUserId: z.string().trim().optional(), billNumber: z.string().trim().optional(),
  customerName: z.string().trim().optional(), totalAmount: z.number().optional(),
  paymentStatus: z.string().trim().optional(), createdAt: z.string().trim().optional(),
});
const workTaskEventSchema = z.object({
  customerId: z.string().trim().min(1), taskId: z.string().trim().min(1),
  actorUserId: z.string().trim().optional(), title: z.string().trim().min(1),
  description: z.string().trim().optional(), status: z.string().trim().optional(),
  priority: z.string().trim().optional(), issueCategory: z.string().trim().optional(),
  dueAt: z.string().trim().optional(), assignedTechnicianName: z.string().trim().optional(),
  customerName: z.string().trim().optional(),
  action: z.enum(["created", "updated", "completed", "cancelled", "hold", "in-progress", "deleted", "due_changed"]).optional(),
  createdAt: z.string().trim().optional(), updatedAt: z.string().trim().optional(),
  completionNotes: z.string().trim().optional(), cancellationReason: z.string().trim().optional(),
  holdReason: z.string().trim().optional(),
});

router.use(requireShopAuth);

// ── Room list (cursor-based paginated, no roster refresh per call) ──
router.get("/rooms", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const search = req.query.search ? String(req.query.search) : undefined;
    const rawLimit = Number(req.query.limit) || 20;
    // limit=0 means "all rooms" (capped at 2000)
    const limit = rawLimit === 0 ? 2000 : Math.min(100, Math.max(1, rawLimit));
    const result = await listRoomsForUser(req.shopUser!, cursor, limit, search);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/room/me", requireCustomer, async (req: AuthRequest, res, next) => {
  try {
    const room = await getOrCreateRoomForCustomer(req.shopUser!);
    res.json({ room: serializeRoom(room) });
  } catch (error) {
    next(error);
  }
});

router.post("/room/customer/:customerId", requireAdmin, async (req, res, next) => {
  try {
    const customerId = String(req.params.customerId);
    const room = await getOrCreateRoomByCustomerId(customerId);
    if (!room) return res.status(404).json({ message: "Customer not found" });
    const payload = serializeRoom(room);
    try { getChatNamespace()?.to("admins").emit("room:updated", payload); } catch {}
    res.json({ room: payload });
  } catch (error) {
    next(error);
  }
});

router.post("/rooms/:roomId/clear", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const room = await assertRoomAccess(req.shopUser!, String(req.params.roomId));
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const result = await clearRoomMessagesForEveryone(room, req.shopUser!);
    const messagePayload = serializeMessage(result.message);
    const roomPayload = serializeRoom(await Room.findById(room._id).lean());
    try {
      getChatNamespace()?.to(`room:${room._id}`).emit("message:cleared", { roomId: String(room._id), message: messagePayload });
      getChatNamespace()?.to(`room:${room._id}`).emit("message:new", messagePayload);
      getChatNamespace()?.to("admins").emit("room:updated", roomPayload);
      getChatNamespace()?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
    } catch {}
    res.json({ message: messagePayload, room: roomPayload });
  } catch (error) {
    next(error);
  }
});

router.post("/events/bill-created", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const input = billCreatedEventSchema.parse(req.body);
    const room = await getOrCreateRoomByCustomerId(input.customerId);
    if (!room) return res.status(404).json({ message: "Customer not found" });
    const amount = Number(input.totalAmount || 0);
    const billLabel = input.billNumber || input.billId;
    const text = `Bill created${amount > 0 ? ` of \u20b9${amount}` : ""}.\nFor more detail click here.`;
    const message = await createMessage({
      room, sender: req.shopUser!, text, type: "text",
      clientMessageId: `event:bill_created:${input.billId}`,
      messageKind: "system", systemEventType: "bill_created",
      systemEventData: {
        eventType: "bill_created", billId: input.billId, billNumber: billLabel,
        customerName: input.customerName || (room as any).customerName || "Customer",
        customerId: input.customerId, actorUserId: input.actorUserId || req.shopUser!.id,
        totalAmount: amount, paymentStatus: input.paymentStatus || "pending",
        createdAt: input.createdAt || new Date().toISOString(),
      },
    });
    const messagePayload = serializeMessage(message);
    const roomPayload = serializeRoom(await Room.findById(room._id).lean());
    const participantIds = ((room as any).participants || []).map((p: any) => String(p.userId));
    try {
      getChatNamespace()?.to(`room:${room._id}`).emit("message:new", messagePayload);
      getChatNamespace()?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
    } catch {}
    void emitSyncEvent({ eventType: "message.created", roomId: String(room._id), payload: messagePayload, userIds: participantIds });
    void notifyChatMessageCreated({ room, message, sender: req.shopUser! });
    res.status(201).json({ message: messagePayload, room: roomPayload });
  } catch (error) {
    next(error);
  }
});

router.post("/events/work-task", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const input = workTaskEventSchema.parse(req.body);
    const room = await getOrCreateRoomByCustomerId(input.customerId);
    if (!room) return res.status(404).json({ message: "Customer not found" });
    const action = input.action || "updated";
    const status = input.status || "pending";
    const dueLine = input.dueAt ? `\nDue: ${input.dueAt}` : "";
    const techLine = input.assignedTechnicianName ? `\nTechnician: ${input.assignedTechnicianName}` : "";
    const actionText =
      action === "created" ? "Shop assigned new work"
      : action === "completed" ? "Shop completed your task"
      : action === "cancelled" ? "Shop cancelled your task"
      : action === "hold" ? "Shop put your task on hold"
      : action === "in-progress" ? "Shop started your task"
      : action === "due_changed" ? "Shop updated your work time"
      : action === "deleted" ? "Shop removed your task"
      : "Shop updated your work";
    const text = `${actionText}: ${input.title}.\nStatus: ${status}${dueLine}${techLine}\nFor more detail click here.`;
    const eventVersion = input.updatedAt || input.createdAt || new Date().toISOString();
    const message = await createMessage({
      room, sender: req.shopUser!, text, type: "text",
      clientMessageId: `event:work_task:${input.taskId}:${action}:${eventVersion}`,
      messageKind: "system", systemEventType: "work_task",
      systemEventData: {
        eventType: "work_task", customerId: input.customerId,
        customerName: input.customerName || (room as any).customerName || "Customer",
        actorUserId: input.actorUserId || req.shopUser!.id, taskId: input.taskId,
        title: input.title, description: input.description || "", status,
        priority: input.priority || "medium", issueCategory: input.issueCategory || "other",
        dueAt: input.dueAt || "", assignedTechnicianName: input.assignedTechnicianName || "",
        action, createdAt: input.createdAt || new Date().toISOString(), updatedAt: eventVersion,
        completionNotes: input.completionNotes || "", cancellationReason: input.cancellationReason || "",
        holdReason: input.holdReason || "",
      },
    });
    const messagePayload = serializeMessage(message);
    const roomPayload = serializeRoom(await Room.findById(room._id).lean());
    try {
      getChatNamespace()?.to(`room:${room._id}`).emit("message:new", messagePayload);
      getChatNamespace()?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
    } catch {}
    void notifyChatMessageCreated({ room, message, sender: req.shopUser! });
    res.status(201).json({ message: messagePayload, room: roomPayload });
  } catch (error) {
    next(error);
  }
});

// ── Messages (cursor-based pagination using _id) ──
router.get("/messages/:roomId", async (req: AuthRequest, res, next) => {
  try {
    const roomId = String(req.params.roomId);
    const room = await assertRoomAccess(req.shopUser!, roomId);
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const filter: any = { roomId: room._id, hiddenFor: { $ne: req.shopUser!.id } };
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      filter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }
    const messages = await Message.find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .lean()
      .select(MESSAGE_PROJECTION);
    const hasMore = messages.length >= limit;
    const nextCursor = messages.length > 0 ? String(messages[messages.length - 1]._id) : null;
    res.json({
      messages: dedupeBillCreatedEvents(messages.reverse()).map(serializeMessage),
      nextCursor,
      hasMore,
    });
  } catch (error) {
    next(error);
  }
});

// ── Send message ──
router.post("/messages", async (req: AuthRequest, res, next) => {
  try {
    const input = sendMessageSchema.parse(req.body);
    const room = await assertRoomAccess(req.shopUser!, input.roomId);
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const message = await createMessage({ room, sender: req.shopUser!, ...input });
    const messagePayload = serializeMessage(message);
    const updatedRoom = await Room.findById(room._id).lean().select(ROOM_PROJECTION);
    const roomPayload = serializeRoom(updatedRoom);
    const participantIds = ((room as any).participants || []).map((p: any) => String(p.userId));
    try {
      getChatNamespace()?.to(`room:${room._id}`).emit("message:new", messagePayload);
      getChatNamespace()?.to("admins").emit("room:updated", roomPayload);
      getChatNamespace()?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
    } catch {}
    void emitSyncEvent({ eventType: "message.created", roomId: String(room._id), payload: messagePayload, userIds: participantIds });
    void notifyChatMessageCreated({ room, message, sender: req.shopUser! });
    res.status(201).json({ message: messagePayload, room: roomPayload });
  } catch (error) {
    next(error);
  }
});

router.patch("/messages/:messageId", async (req: AuthRequest, res, next) => {
  try {
    const input = editMessageSchema.parse(req.body);
    const result = await editMessage(String(req.params.messageId), req.shopUser!, input.text);
    if (!result) return res.status(404).json({ message: "Message not found" });
    const messagePayload = serializeMessage(result.message);
    try { getChatNamespace()?.to(`room:${result.room._id}`).emit("message:status", { messages: [messagePayload] }); } catch {}
    const updatedRoom = await Room.findById(result.room._id).lean().select(ROOM_PROJECTION);
    try {
      getChatNamespace()?.to("admins").emit("room:updated", serializeRoom(updatedRoom));
      getChatNamespace()?.to(`user:${result.room.customerId}`).emit("room:updated", serializeRoom(updatedRoom));
    } catch {}
    res.json({ message: messagePayload, room: serializeRoom(updatedRoom) });
  } catch (error) {
    next(error);
  }
});

router.delete("/messages/:messageId", async (req: AuthRequest, res, next) => {
  try {
    const input = deleteMessageSchema.parse(req.body || {});
    const result = await deleteMessage(String(req.params.messageId), req.shopUser!, input.scope);
    if (!result) return res.status(404).json({ message: "Message not found" });
    if (result.localOnly) return res.json({ ok: true, messageId: String(result.message._id), localOnly: true });
    const messagePayload = serializeMessage(result.message);
    const updatedRoom = await Room.findById(result.room._id).lean().select(ROOM_PROJECTION);
    try {
      getChatNamespace()?.to(`room:${result.room._id}`).emit("message:status", { messages: [messagePayload] });
      getChatNamespace()?.to("admins").emit("room:updated", serializeRoom(updatedRoom));
      getChatNamespace()?.to(`user:${result.room.customerId}`).emit("room:updated", serializeRoom(updatedRoom));
    } catch {}
    res.json({ message: messagePayload, room: serializeRoom(updatedRoom), localOnly: false });
  } catch (error) {
    next(error);
  }
});

router.post("/messages/:messageId/react", async (req: AuthRequest, res, next) => {
  try {
    const input = reactMessageSchema.parse(req.body);
    const result = await reactToMessage(String(req.params.messageId), req.shopUser!, input.emoji);
    if (!result?.message) return res.status(404).json({ message: "Message not found" });
    const messagePayload = serializeMessage(result.message);
    try { getChatNamespace()?.to(`room:${result.room._id}`).emit("message:status", { messages: [messagePayload] }); } catch {}
    res.json({ message: messagePayload });
  } catch (error) {
    next(error);
  }
});

router.post("/messages/:messageId/forward", async (req: AuthRequest, res, next) => {
  try {
    const input = forwardMessageSchema.parse(req.body);
    const original = await Message.findById(String(req.params.messageId)).lean();
    if (!original) return res.status(404).json({ message: "Message not found" });
    const originalRoom = await assertRoomAccess(req.shopUser!, String(original.roomId));
    const targetRoom = await assertRoomAccess(req.shopUser!, input.roomId);
    if (!originalRoom || !targetRoom) return res.status(403).json({ message: "Room access denied" });
    const message = await createMessage({
      room: targetRoom, sender: req.shopUser!,
      text: String(original.text || ""), type: original.type || "text",
      attachments: original.attachments || [], media: original.media || null,
      forwarded: true, forwardedFrom: String(original._id),
    });
    const messagePayload = serializeMessage(message);
    const roomPayload = serializeRoom(await Room.findById(targetRoom._id).lean());
    try {
      getChatNamespace()?.to(`room:${targetRoom._id}`).emit("message:new", messagePayload);
      getChatNamespace()?.to("admins").emit("room:updated", roomPayload);
      getChatNamespace()?.to(`user:${targetRoom.customerId}`).emit("room:updated", roomPayload);
    } catch {}
    res.status(201).json({ message: messagePayload, room: roomPayload });
  } catch (error) {
    next(error);
  }
});

// ── Bulk mark delivered ──
router.patch("/messages/:messageId/status", async (req: AuthRequest, res, next) => {
  try {
    const messageId = String(req.params.messageId);
    const message = await Message.findById(messageId).lean();
    if (!message) return res.status(404).json({ message: "Message not found" });
    const room = await assertRoomAccess(req.shopUser!, String(message.roomId));
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const payload = await markDelivered([messageId], req.shopUser!);
    try { getChatNamespace()?.to(`room:${room._id}`).emit("message:status", { messages: payload }); } catch {}
    res.json({ messages: payload });
  } catch (error) {
    next(error);
  }
});

// ── Bulk mark as read (all messages in room from other user) ──
router.post("/messages/seen", async (req: AuthRequest, res, next) => {
  try {
    const { roomId } = z.object({ roomId: z.string() }).parse(req.body);
    const room = await assertRoomAccess(req.shopUser!, roomId);
    if (!room) return res.status(403).json({ message: "Room access denied" });
    // Bulk update all unread messages from other users
    await Message.updateMany(
      { roomId: room._id, senderId: { $ne: req.shopUser!.id }, "readBy.userId": { $ne: req.shopUser!.id } },
      { $addToSet: { readBy: { userId: req.shopUser!.id, role: req.shopUser!.role, name: req.shopUser!.name, at: new Date() } }, $set: { status: "read" } },
    );
    await Room.updateOne({ _id: room._id }, { $set: { [`unreadBy.${req.shopUser!.id}`]: 0 } });
    try {
      getChatNamespace()?.to(`room:${room._id}`).emit("message:read", { roomId, userId: req.shopUser!.id, messageIds: [] });
    } catch {}
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Mark individual message as read ──
router.patch("/messages/:messageId/read", async (req: AuthRequest, res, next) => {
  try {
    const messageId = String(req.params.messageId);
    const message = await Message.findById(messageId).lean();
    if (!message) return res.status(404).json({ message: "Message not found" });
    const room = await assertRoomAccess(req.shopUser!, String(message.roomId));
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const messages = await markRoomRead(room, req.shopUser!, [messageId]);
    try {
      getChatNamespace()?.to(`room:${room._id}`).emit("message:read", { roomId: String(room._id), userId: req.shopUser!.id, messageIds: [messageId] });
      getChatNamespace()?.to(`room:${room._id}`).emit("message:status", { messages });
    } catch {}
    res.json({ ok: true, messages });
  } catch (error) {
    next(error);
  }
});

// ── Sync endpoint ──
router.get("/sync", async (req: AuthRequest, res, next) => {
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
    const events = await getSyncEventsSince(since, req.shopUser!.id);
    res.json({ events });
  } catch (error) {
    next(error);
  }
});

// ── Media upload sign ──
router.post("/media/sign-upload", async (req: AuthRequest, res, next) => {
  try {
    const { fileName, contentType } = z.object({
      fileName: z.string().min(1),
      contentType: z.string().min(1),
    }).parse(req.body);
    const { createSignedUpload } = await import("../services/storageService");
    const result = await createSignedUpload(fileName, contentType);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
