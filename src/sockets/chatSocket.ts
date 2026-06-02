import type { Server, Socket } from "socket.io";
import { extractAuthStorageFromHeaders, isAdmin, verifyShopAuth } from "../services/shopAuth";
import {
  assertRoomAccess,
  createMessage,
  getOrCreateRoomForCustomer,
  markDelivered,
  markRoomRead,
  serializeMessage,
  serializeRoom,
} from "../services/roomService";
import { Room } from "../models/Room";
import type { ShopUser } from "../types/auth";

let chatNamespace: ReturnType<Server["of"]> | null = null;
const onlineUsers = new Map<string, { user: ShopUser; sockets: number }>();
const lastSeenByUser = new Map<string, string>();

export function getChatNamespace() {
  return chatNamespace;
}

function emitPresence() {
  const users = Array.from(onlineUsers.values()).map(({ user }) => ({
    userId: user.id,
    role: user.role,
    name: user.name,
    online: true,
    lastSeen: lastSeenByUser.get(user.id) || new Date().toISOString(),
  }));
  const lastSeen = Array.from(lastSeenByUser.entries()).map(([userId, at]) => ({ userId, online: false, lastSeen: at }));
  chatNamespace?.emit("presence:snapshot", { users, lastSeen });
}

async function authenticateSocket(socket: Socket) {
  const authStorage =
    typeof socket.handshake.auth?.authStorage === "string"
      ? socket.handshake.auth.authStorage
      : extractAuthStorageFromHeaders(socket.handshake.headers as Record<string, unknown>);
  return verifyShopAuth(authStorage);
}

export function registerChatSocket(io: Server) {
  chatNamespace = io.of("/chat");

  chatNamespace.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket);
      if (!user) return next(new Error("Unauthorized"));
      socket.data.user = user;
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  chatNamespace.on("connection", async (socket) => {
    const user = socket.data.user as ShopUser;
    socket.join(`user:${user.id}`);
    if (isAdmin(user)) socket.join("admins");

    const previous = onlineUsers.get(user.id);
    lastSeenByUser.set(user.id, new Date().toISOString());
    onlineUsers.set(user.id, { user, sockets: (previous?.sockets || 0) + 1 });
    emitPresence();

    if (user.role === "customer") {
      try {
        const room = await getOrCreateRoomForCustomer(user);
        socket.join(`room:${room._id}`);
        socket.emit("room:joined", { room: serializeRoom(room) });
      } catch {}
    }

    socket.on("room:join", async ({ roomId }: { roomId?: string }) => {
      try {
        if (!roomId) return;
        const room = await assertRoomAccess(user, roomId);
        if (!room) {
          socket.emit("room:error", { roomId, message: "Room access denied" });
          return;
        }
        socket.join(`room:${room._id}`);
        socket.emit("room:joined", { room: serializeRoom(room) });
      } catch {
        socket.emit("room:error", { roomId, message: "Unable to join room" });
      }
    });

    socket.on("room:leave", ({ roomId }: { roomId?: string }) => {
      if (!roomId) return;
      socket.leave(`room:${roomId}`);
    });

    socket.on(
      "message:send",
      async (
        input: {
          roomId?: string;
          text?: string;
          type?: "text" | "image" | "video" | "audio" | "file";
          attachments?: unknown[];
          replyTo?: { messageId: string; text: string; senderId: string; senderName?: string } | null;
          clientMessageId?: string;
        },
        ack?: (payload: { ok: boolean; message?: unknown; room?: unknown; error?: string; clientMessageId?: string }) => void,
      ) => {
        try {
          if (!input.roomId || !String(input.text || "").trim()) {
            ack?.({ ok: false, error: "roomId and text required", clientMessageId: input.clientMessageId });
            return;
          }
          const room = await assertRoomAccess(user, input.roomId);
          if (!room) {
            ack?.({ ok: false, error: "Room access denied", clientMessageId: input.clientMessageId });
            return;
          }
          const message = await createMessage({
            room,
            sender: user,
            text: String(input.text),
            type: input.type || "text",
            attachments: input.attachments || [],
            replyTo: input.replyTo || null,
            clientMessageId: input.clientMessageId,
          });
          const messagePayload = serializeMessage(message);
          const updatedRoom = await Room.findById(room._id).lean();
          const roomPayload = serializeRoom(updatedRoom);
          chatNamespace?.to(`room:${room._id}`).emit("message:new", messagePayload);
          chatNamespace?.to("admins").emit("room:updated", roomPayload);
          chatNamespace?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
          ack?.({ ok: true, message: messagePayload, room: roomPayload, clientMessageId: input.clientMessageId });
        } catch (error) {
          ack?.({ ok: false, error: "Message failed", clientMessageId: input.clientMessageId });
        }
      },
    );

    socket.on("typing:update", async ({ roomId, typing }: { roomId?: string; typing?: boolean }) => {
      if (!roomId) return;
      const room = await assertRoomAccess(user, roomId);
      if (!room) return;
      socket.to(`room:${room._id}`).emit("typing:update", {
        roomId: String(room._id),
        userId: user.id,
        role: user.role,
        name: user.name,
        typing: Boolean(typing),
        at: new Date().toISOString(),
      });
    });

    socket.on("message:delivered", async ({ messageIds }: { messageIds?: string[] }) => {
      const payload = await markDelivered(Array.isArray(messageIds) ? messageIds : [], user);
      const roomIds = Array.from(new Set(payload.map((message: any) => String(message.roomId))));
      for (const roomId of roomIds) {
        chatNamespace?.to(`room:${roomId}`).emit("message:status", { messages: payload.filter((m: any) => String(m.roomId) === roomId) });
      }
    });

    socket.on("message:read", async ({ roomId, messageIds }: { roomId?: string; messageIds?: string[] }) => {
      if (!roomId) return;
      const room = await assertRoomAccess(user, roomId);
      if (!room) return;
      const messages = await markRoomRead(room, user, Array.isArray(messageIds) ? messageIds : undefined);
      const updatedRoom = await Room.findById(room._id).lean();
      chatNamespace?.to(`room:${room._id}`).emit("message:read", {
        roomId: String(room._id),
        userId: user.id,
        messageIds: Array.isArray(messageIds) ? messageIds : [],
      });
      chatNamespace?.to(`room:${room._id}`).emit("message:status", { messages });
      chatNamespace?.to("admins").emit("room:updated", serializeRoom(updatedRoom));
      chatNamespace?.to(`user:${room.customerId}`).emit("room:updated", serializeRoom(updatedRoom));
    });

    socket.on("disconnect", () => {
      const previous = onlineUsers.get(user.id);
      if (!previous || previous.sockets <= 1) {
        onlineUsers.delete(user.id);
        lastSeenByUser.set(user.id, new Date().toISOString());
      } else {
        onlineUsers.set(user.id, { user, sockets: previous.sockets - 1 });
      }
      emitPresence();
    });
  });
}
