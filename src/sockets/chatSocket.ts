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
import { notifyChatMessageCreated } from "../services/notificationService";

let chatNamespace: ReturnType<Server["of"]> | null = null;
const PRESENCE_TTL_MS = 75_000;
const PRESENCE_PRUNE_INTERVAL_MS = 30_000;

const onlineUsers = new Map<string, { user: ShopUser; sockets: Map<string, string> }>();
const lastSeenByUser = new Map<string, string>();
const activeChatBySocket = new Map<string, { userId: string; roomId: string }>();
let presencePruneTimer: NodeJS.Timeout | null = null;

export function getChatNamespace() {
  return chatNamespace;
}

export function isUserActiveInChatRoom(userId: string, roomId: string) {
  for (const active of activeChatBySocket.values()) {
    if (active.userId === userId && active.roomId === roomId) return true;
  }
  return false;
}

function deviceRoom(userId: string, deviceId: string) {
  return `device:${userId}:${deviceId}`;
}

export function emitDeviceRevoked(input: {
  userId: string;
  deviceId?: string;
  reason?: string;
  loggedInOn?: string;
  message?: string;
}) {
  if (!chatNamespace || !input.userId) return false;
  const payload = {
    reason: input.reason || "LOGGED_IN_ON_ANOTHER_DEVICE",
    deviceId: input.deviceId,
    loggedInOn: input.loggedInOn,
    message:
      input.message ||
      "Your account has been logged out from this device because it was logged in on another device.",
    at: new Date().toISOString(),
  };
  if (input.deviceId) {
    chatNamespace.to(deviceRoom(input.userId, input.deviceId)).emit("session:revoked", payload);
    return true;
  }
  chatNamespace.to(`user:${input.userId}`).emit("session:revoked", payload);
  return true;
}

function emitPresence() {
  pruneStalePresence(false);
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

function touchPresence(socket: Socket, user: ShopUser) {
  const previous = onlineUsers.get(user.id);
  const sockets = previous?.sockets || new Map<string, string>();
  const now = new Date().toISOString();
  sockets.set(socket.id, now);
  lastSeenByUser.set(user.id, now);
  onlineUsers.set(user.id, { user, sockets });
}

function removePresence(socket: Socket, user: ShopUser) {
  const previous = onlineUsers.get(user.id);
  if (!previous) return;
  previous.sockets.delete(socket.id);
  if (previous.sockets.size === 0) {
    onlineUsers.delete(user.id);
    lastSeenByUser.set(user.id, new Date().toISOString());
    return;
  }
  onlineUsers.set(user.id, previous);
}

function pruneStalePresence(shouldEmit = true) {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  let changed = false;

  for (const [userId, presence] of onlineUsers.entries()) {
    for (const [socketId, lastSeen] of presence.sockets.entries()) {
      const lastSeenTime = Date.parse(lastSeen);
      if (!Number.isFinite(lastSeenTime) || lastSeenTime < cutoff) {
        presence.sockets.delete(socketId);
        changed = true;
      }
    }

    if (presence.sockets.size === 0) {
      onlineUsers.delete(userId);
      lastSeenByUser.set(userId, new Date().toISOString());
    }
  }

  if (changed && shouldEmit) emitPresence();
}

function startPresencePruner() {
  if (presencePruneTimer) return;
  presencePruneTimer = setInterval(() => pruneStalePresence(), PRESENCE_PRUNE_INTERVAL_MS);
  presencePruneTimer.unref?.();
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
  startPresencePruner();

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
    const contributesPresence = socket.handshake.auth?.presence !== false;
    socket.join(`user:${user.id}`);
    const initialDeviceId =
      typeof socket.handshake.auth?.deviceId === "string"
        ? socket.handshake.auth.deviceId.trim()
        : "";
    if (initialDeviceId) {
      socket.join(deviceRoom(user.id, initialDeviceId));
      socket.data.deviceId = initialDeviceId;
    }
    if (isAdmin(user)) socket.join("admins");

    if (contributesPresence) {
      touchPresence(socket, user);
      emitPresence();
    }

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
      const active = activeChatBySocket.get(socket.id);
      if (active?.roomId === roomId) activeChatBySocket.delete(socket.id);
    });

    socket.on("chat:active", async ({ roomId }: { roomId?: string | null }) => {
      const nextRoomId = String(roomId || "").trim();
      if (!nextRoomId) {
        activeChatBySocket.delete(socket.id);
        return;
      }
      const room = await assertRoomAccess(user, nextRoomId);
      if (!room) return;
      activeChatBySocket.set(socket.id, { userId: user.id, roomId: String(room._id) });
    });

    socket.on("device:register", ({ deviceId }: { deviceId?: string }) => {
      const nextDeviceId = String(deviceId || "").trim();
      if (!nextDeviceId) return;
      const previousDeviceId = typeof socket.data.deviceId === "string" ? socket.data.deviceId : "";
      if (previousDeviceId && previousDeviceId !== nextDeviceId) {
        socket.leave(deviceRoom(user.id, previousDeviceId));
      }
      socket.data.deviceId = nextDeviceId;
      socket.join(deviceRoom(user.id, nextDeviceId));
    });

    socket.on("presence:ping", () => {
      if (!contributesPresence) return;
      touchPresence(socket, user);
    });

    socket.on("presence:offline", () => {
      if (!contributesPresence) return;
      removePresence(socket, user);
      emitPresence();
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
          void notifyChatMessageCreated({ room, message, sender: user });
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
      activeChatBySocket.delete(socket.id);
      if (contributesPresence) {
        removePresence(socket, user);
        emitPresence();
      }
    });
  });
}
