import { Router } from "express";
import { z } from "zod";
import { Message } from "../models/Message";
import { Room } from "../models/Room";
import { requireAdmin, requireCustomer, requireShopAuth, type AuthRequest } from "../middleware/auth";
import {
  assertRoomAccess,
  createMessage,
  deleteMessage,
  editMessage,
  getOrCreateRoomByCustomerId,
  getOrCreateRoomForCustomer,
  markDelivered,
  markRoomRead,
  reactToMessage,
  refreshRoomSupportRoster,
  serializeMessage,
  serializeRoom,
} from "../services/roomService";
import { getChatNamespace } from "../sockets/chatSocket";
import { notifyChatMessageCreated } from "../services/notificationService";

const router = Router();

function billCreatedEventKey(message: any) {
  const eventType = String(message?.systemEventType || message?.systemEventData?.eventType || "");
  const clientMessageId = String(message?.clientMessageId || "");
  if (eventType !== "bill_created" && !clientMessageId.startsWith("event:bill_created:")) {
    return "";
  }
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

const sendMessageSchema = z.object({
  roomId: z.string(),
  text: z.string().trim().min(1).max(5000),
  type: z.enum(["text", "image", "video", "audio", "file"]).optional(),
  attachments: z.array(z.unknown()).optional(),
  clientMessageId: z.string().trim().max(120).optional(),
  replyTo: z
    .object({
      messageId: z.string(),
      text: z.string(),
      senderId: z.string(),
      senderName: z.string().optional(),
    })
    .nullable()
    .optional(),
});
const editMessageSchema = z.object({
  text: z.string().trim().min(1).max(5000),
});
const deleteMessageSchema = z.object({
  scope: z.enum(["me", "everyone"]).default("everyone"),
});
const reactMessageSchema = z.object({
  emoji: z.string().trim().min(1).max(16).nullable(),
});
const forwardMessageSchema = z.object({
  roomId: z.string(),
});
const billCreatedEventSchema = z.object({
  customerId: z.string().trim().min(1),
  billId: z.string().trim().min(1),
  billNumber: z.string().trim().optional(),
  customerName: z.string().trim().optional(),
  totalAmount: z.number().optional(),
  paymentStatus: z.string().trim().optional(),
  createdAt: z.string().trim().optional(),
});
const workTaskEventSchema = z.object({
  customerId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().optional(),
  status: z.string().trim().optional(),
  priority: z.string().trim().optional(),
  issueCategory: z.string().trim().optional(),
  dueAt: z.string().trim().optional(),
  assignedTechnicianName: z.string().trim().optional(),
  customerName: z.string().trim().optional(),
  action: z
    .enum(["created", "updated", "completed", "cancelled", "hold", "in-progress", "deleted", "due_changed"])
    .optional(),
  createdAt: z.string().trim().optional(),
  updatedAt: z.string().trim().optional(),
  completionNotes: z.string().trim().optional(),
  cancellationReason: z.string().trim().optional(),
  holdReason: z.string().trim().optional(),
});

router.use(requireShopAuth);

router.get("/rooms", requireAdmin, async (_req, res, next) => {
  try {
    const roomDocs = await Room.find({}).sort({ updatedAt: -1 }).limit(500);
    const rooms = await Promise.all(roomDocs.map((room) => refreshRoomSupportRoster(room as any)));
    res.json({ rooms: rooms.map(serializeRoom) });
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
    getChatNamespace()?.to("admins").emit("room:updated", payload);
    res.json({ room: payload });
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
      room,
      sender: req.shopUser!,
      text,
      type: "text",
      clientMessageId: `event:bill_created:${input.billId}`,
      messageKind: "system",
      systemEventType: "bill_created",
      systemEventData: {
        eventType: "bill_created",
        billId: input.billId,
        billNumber: billLabel,
        customerName: input.customerName || (room as any).customerName || "Customer",
        customerId: input.customerId,
        totalAmount: amount,
        paymentStatus: input.paymentStatus || "pending",
        createdAt: input.createdAt || new Date().toISOString(),
      },
    });

    const messagePayload = serializeMessage(message);
    const roomPayload = serializeRoom(await Room.findById(room._id).lean());
    getChatNamespace()?.to(`room:${room._id}`).emit("message:new", messagePayload);
    getChatNamespace()?.to("admins").emit("room:updated", roomPayload);
    getChatNamespace()?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
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
      action === "created"
        ? "New work assigned"
        : action === "completed"
          ? "Task completed"
          : action === "cancelled"
            ? "Service task cancelled"
            : action === "hold"
              ? "Service task put on hold"
              : action === "in-progress"
                ? "Service task is in progress"
                : action === "due_changed"
                  ? "Service task time updated"
                  : action === "deleted"
                    ? "Service task deleted"
                    : "Service task updated";
    const text = `${actionText}: ${input.title}.\nStatus: ${status}${dueLine}${techLine}\nFor more detail click here.`;
    const eventVersion = input.updatedAt || input.createdAt || new Date().toISOString();
    const message = await createMessage({
      room,
      sender: req.shopUser!,
      text,
      type: "text",
      clientMessageId: `event:work_task:${input.taskId}:${action}:${eventVersion}`,
      messageKind: "system",
      systemEventType: "work_task",
      systemEventData: {
        eventType: "work_task",
        customerId: input.customerId,
        customerName: input.customerName || (room as any).customerName || "Customer",
        taskId: input.taskId,
        title: input.title,
        description: input.description || "",
        status,
        priority: input.priority || "medium",
        issueCategory: input.issueCategory || "other",
        dueAt: input.dueAt || "",
        assignedTechnicianName: input.assignedTechnicianName || "",
        action,
        createdAt: input.createdAt || new Date().toISOString(),
        updatedAt: eventVersion,
        completionNotes: input.completionNotes || "",
        cancellationReason: input.cancellationReason || "",
        holdReason: input.holdReason || "",
      },
    });

    const messagePayload = serializeMessage(message);
    const roomPayload = serializeRoom(await Room.findById(room._id).lean());
    getChatNamespace()?.to(`room:${room._id}`).emit("message:new", messagePayload);
    getChatNamespace()?.to("admins").emit("room:updated", roomPayload);
    getChatNamespace()?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
    res.status(201).json({ message: messagePayload, room: roomPayload });
  } catch (error) {
    next(error);
  }
});

router.get("/messages/:roomId", async (req: AuthRequest, res, next) => {
  try {
    const roomId = String(req.params.roomId);
    const room = await assertRoomAccess(req.shopUser!, roomId);
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const filter: any = { roomId: room._id, hiddenFor: { $ne: req.shopUser!.id } };
    if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
    const messages = await Message.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ messages: dedupeBillCreatedEvents(messages.reverse()).map(serializeMessage) });
  } catch (error) {
    next(error);
  }
});

router.post("/messages", async (req: AuthRequest, res, next) => {
  try {
    const input = sendMessageSchema.parse(req.body);
    const room = await assertRoomAccess(req.shopUser!, input.roomId);
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const message = await createMessage({ room, sender: req.shopUser!, ...input });
    const messagePayload = serializeMessage(message);
    const updatedRoom = await Room.findById(room._id).lean();
    const roomPayload = serializeRoom(updatedRoom);
    getChatNamespace()?.to(`room:${room._id}`).emit("message:new", messagePayload);
    getChatNamespace()?.to("admins").emit("room:updated", roomPayload);
    getChatNamespace()?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
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
    getChatNamespace()?.to(`room:${result.room._id}`).emit("message:status", { messages: [messagePayload] });
    const updatedRoom = await Room.findById(result.room._id).lean();
    getChatNamespace()?.to("admins").emit("room:updated", serializeRoom(updatedRoom));
    getChatNamespace()?.to(`user:${result.room.customerId}`).emit("room:updated", serializeRoom(updatedRoom));
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
    const updatedRoom = await Room.findById(result.room._id).lean();
    getChatNamespace()?.to(`room:${result.room._id}`).emit("message:status", { messages: [messagePayload] });
    getChatNamespace()?.to("admins").emit("room:updated", serializeRoom(updatedRoom));
    getChatNamespace()?.to(`user:${result.room.customerId}`).emit("room:updated", serializeRoom(updatedRoom));
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
    getChatNamespace()?.to(`room:${result.room._id}`).emit("message:status", { messages: [messagePayload] });
    res.json({ message: messagePayload });
  } catch (error) {
    next(error);
  }
});

router.post("/messages/:messageId/forward", async (req: AuthRequest, res, next) => {
  try {
    const input = forwardMessageSchema.parse(req.body);
    const original = await Message.findById(String(req.params.messageId));
    if (!original) return res.status(404).json({ message: "Message not found" });
    const originalRoom = await assertRoomAccess(req.shopUser!, String(original.roomId));
    const targetRoom = await assertRoomAccess(req.shopUser!, input.roomId);
    if (!originalRoom || !targetRoom) return res.status(403).json({ message: "Room access denied" });
    const message = await createMessage({
      room: targetRoom,
      sender: req.shopUser!,
      text: String((original as any).text || ""),
      type: (original as any).type || "text",
      attachments: (original as any).attachments || [],
      forwarded: true,
      forwardedFrom: String(original._id),
    });
    const messagePayload = serializeMessage(message);
    const roomPayload = serializeRoom(await Room.findById(targetRoom._id).lean());
    getChatNamespace()?.to(`room:${targetRoom._id}`).emit("message:new", messagePayload);
    getChatNamespace()?.to("admins").emit("room:updated", roomPayload);
    getChatNamespace()?.to(`user:${targetRoom.customerId}`).emit("room:updated", roomPayload);
    res.status(201).json({ message: messagePayload, room: roomPayload });
  } catch (error) {
    next(error);
  }
});

router.patch("/messages/:messageId/status", async (req: AuthRequest, res, next) => {
  try {
    const messageId = String(req.params.messageId);
    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });
    const room = await assertRoomAccess(req.shopUser!, String(message.roomId));
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const payload = await markDelivered([messageId], req.shopUser!);
    getChatNamespace()?.to(`room:${room._id}`).emit("message:status", { messages: payload });
    res.json({ messages: payload });
  } catch (error) {
    next(error);
  }
});

router.patch("/messages/:messageId/read", async (req: AuthRequest, res, next) => {
  try {
    const messageId = String(req.params.messageId);
    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });
    const room = await assertRoomAccess(req.shopUser!, String(message.roomId));
    if (!room) return res.status(403).json({ message: "Room access denied" });
    const messages = await markRoomRead(room, req.shopUser!, [messageId]);
    getChatNamespace()?.to(`room:${room._id}`).emit("message:read", {
      roomId: String(room._id),
      userId: req.shopUser!.id,
      messageIds: [messageId],
    });
    getChatNamespace()?.to(`room:${room._id}`).emit("message:status", { messages });
    res.json({ ok: true, messages });
  } catch (error) {
    next(error);
  }
});

export default router;
