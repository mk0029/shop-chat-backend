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

const router = Router();

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
    res.json({ messages: messages.reverse().map(serializeMessage) });
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
