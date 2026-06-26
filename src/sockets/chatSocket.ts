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
import { Message } from "../models/Message";
import { Room } from "../models/Room";
import type { ShopUser } from "../types/auth";
import { notifyChatMessageCreated } from "../services/notificationService";

let chatNamespace: ReturnType<Server["of"]> | null = null;
const PRESENCE_TTL_MS = 75_000;
const PRESENCE_PRUNE_INTERVAL_MS = 30_000;
const TYPING_HEARTBEAT_MS = 4_000;
const TYPING_PRUNE_INTERVAL_MS = 2_000;

const onlineUsers = new Map<string, { user: ShopUser; sockets: Map<string, string> }>();
const lastSeenByUser = new Map<string, string>();
const activeChatBySocket = new Map<string, { userId: string; roomId: string }>();
const typingState = new Map<string, { userId: string; roomId: string; at: number; name: string; role: string }>();
let presencePruneTimer: NodeJS.Timeout | null = null;
let typingPruneTimer: NodeJS.Timeout | null = null;

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
  try {
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
  } catch {
    return false;
  }
}

function emitPresence() {
  try {
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
  } catch {}
}

function touchPresence(socket: Socket, user: ShopUser) {
  try {
    const previous = onlineUsers.get(user.id);
    const sockets = previous?.sockets || new Map<string, string>();
    const now = new Date().toISOString();
    sockets.set(socket.id, now);
    lastSeenByUser.set(user.id, now);
    onlineUsers.set(user.id, { user, sockets });
  } catch {}
}

function removePresence(socket: Socket, user: ShopUser) {
  try {
    const previous = onlineUsers.get(user.id);
    if (!previous) return;
    previous.sockets.delete(socket.id);
    if (previous.sockets.size === 0) {
      onlineUsers.delete(user.id);
      lastSeenByUser.set(user.id, new Date().toISOString());
      return;
    }
    onlineUsers.set(user.id, previous);
  } catch {}
}

function setTypingKey(userId: string, roomId: string) {
  return `${userId}:${roomId}`;
}

function touchTyping(userId: string, roomId: string, name: string, role: string) {
  const key = setTypingKey(userId, roomId);
  typingState.set(key, { userId, roomId, at: Date.now(), name, role });
}

function clearTyping(userId: string, roomId: string) {
  const key = setTypingKey(userId, roomId);
  typingState.delete(key);
}

function isUserTyping(userId: string, roomId: string) {
  const key = setTypingKey(userId, roomId);
  const entry = typingState.get(key);
  if (!entry) return false;
  if (Date.now() - entry.at > TYPING_HEARTBEAT_MS) {
    typingState.delete(key);
    return false;
  }
  return true;
}

function pruneStaleTyping() {
  const now = Date.now();
  const stale: Array<{ userId: string; roomId: string }> = [];
  for (const [, entry] of typingState) {
    if (now - entry.at > TYPING_HEARTBEAT_MS) {
      stale.push({ userId: entry.userId, roomId: entry.roomId });
    }
  }
  for (const { userId, roomId } of stale) {
    const key = setTypingKey(userId, roomId);
    typingState.delete(key);
    try {
      chatNamespace?.to(`room:${roomId}`).emit("typing:update", {
        roomId,
        userId,
        role: "",
        name: "",
        typing: false,
        at: new Date().toISOString(),
      });
    } catch {}
  }
}

function pruneStalePresence(shouldEmit = true) {
  try {
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
  } catch {}
}

function startPresencePruner() {
  if (presencePruneTimer) return;
  presencePruneTimer = setInterval(() => pruneStalePresence(), PRESENCE_PRUNE_INTERVAL_MS);
  presencePruneTimer.unref?.();
  if (typingPruneTimer) return;
  typingPruneTimer = setInterval(() => pruneStaleTyping(), TYPING_PRUNE_INTERVAL_MS);
  typingPruneTimer.unref?.();
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
        try {
          socket.emit("room:error", { roomId, message: "Unable to join room" });
        } catch {}
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
          media?: Record<string, unknown> | null;
          replyTo?: { messageId: string; text: string; senderId: string; senderName?: string } | null;
          clientMessageId?: string;
        },
        ack?: (payload: { ok: boolean; message?: unknown; room?: unknown; error?: string; clientMessageId?: string }) => void,
      ) => {
        try {
          if (!input.roomId || (!String(input.text || "").trim() && !input.media)) {
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
            media: input.media || null,
            replyTo: input.replyTo || null,
            clientMessageId: input.clientMessageId,
          });
          const messagePayload = serializeMessage(message);
          const updatedRoom = await Room.findById(room._id).lean();
          const roomPayload = serializeRoom(updatedRoom);
          try {
            chatNamespace?.to(`room:${room._id}`).emit("message:new", messagePayload);
            chatNamespace?.to("admins").emit("room:updated", roomPayload);
            chatNamespace?.to(`user:${room.customerId}`).emit("room:updated", roomPayload);
          } catch {}
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
      const rid = String(room._id);
      const isTyping = Boolean(typing);
      if (isTyping) {
        touchTyping(user.id, rid, user.name, user.role);
      } else {
        clearTyping(user.id, rid);
      }
      try {
        socket.to(`room:${rid}`).emit("typing:update", {
          roomId: rid,
          userId: user.id,
          role: user.role,
          name: user.name,
          typing: isTyping,
          at: new Date().toISOString(),
        });
      } catch {}
    });

    socket.on("message:delivered", async ({ messageIds }: { messageIds?: string[] }) => {
      const payload = await markDelivered(Array.isArray(messageIds) ? messageIds : [], user);
      const roomIds = Array.from(new Set(payload.map((message: any) => String(message.roomId))));
      try {
        for (const roomId of roomIds) {
          chatNamespace?.to(`room:${roomId}`).emit("message:status", { messages: payload.filter((m: any) => String(m.roomId) === roomId) });
        }
      } catch {}
    });

    socket.on("message:read", async ({ roomId, messageIds }: { roomId?: string; messageIds?: string[] }) => {
      if (!roomId) return;
      const room = await assertRoomAccess(user, roomId);
      if (!room) return;
      const messages = await markRoomRead(room, user, Array.isArray(messageIds) ? messageIds : undefined);
      const updatedRoom = await Room.findById(room._id).lean();
      try {
        chatNamespace?.to(`room:${room._id}`).emit("message:read", {
          roomId: String(room._id),
          userId: user.id,
          messageIds: Array.isArray(messageIds) ? messageIds : [],
        });
        chatNamespace?.to(`room:${room._id}`).emit("message:status", { messages });
        chatNamespace?.to("admins").emit("room:updated", serializeRoom(updatedRoom));
        chatNamespace?.to(`user:${room.customerId}`).emit("room:updated", serializeRoom(updatedRoom));
      } catch {}
    });

    socket.on("message:seen", async ({ roomId }: { roomId?: string }) => {
      if (!roomId) return;
      const room = await assertRoomAccess(user, roomId);
      if (!room) return;
      try {
        await Message.updateMany(
          { roomId: room._id, senderId: { $ne: user.id }, "readBy.userId": { $ne: user.id } },
          { $addToSet: { readBy: { userId: user.id, role: user.role, name: user.name, at: new Date() } }, $set: { status: "read" } },
        );
        await Room.updateOne({ _id: room._id }, { $set: { [`unreadBy.${user.id}`]: 0 } });
        chatNamespace?.to(`room:${room._id}`).emit("message:read", { roomId: String(room._id), userId: user.id, messageIds: [] });
      } catch {}
    });

    socket.on("disconnect", () => {
      activeChatBySocket.delete(socket.id);
      for (const [key, entry] of typingState) {
        if (entry.userId === user.id) {
          const rid = entry.roomId;
          typingState.delete(key);
          try {
            chatNamespace?.to(`room:${rid}`).emit("typing:update", {
              roomId: rid,
              userId: user.id,
              role: user.role,
              name: user.name,
              typing: false,
              at: new Date().toISOString(),
            });
          } catch {}
        }
      }
      if (contributesPresence) {
        removePresence(socket, user);
        emitPresence();
      }
    });
  });
}
