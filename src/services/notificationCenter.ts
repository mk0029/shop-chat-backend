import { createHash } from "crypto";
import { env } from "../config/env";
import { sanityClient } from "../config/sanity";
import { FcmToken, type FcmTokenDoc } from "../models/FcmToken";
import { NotificationDeviceSetting } from "../models/NotificationDeviceSetting";
import { NotificationLog } from "../models/NotificationLog";
import { getFirebaseMessaging } from "./firebaseAdmin";
import { emitDeviceRevoked, isUserActiveInChatRoom } from "../sockets/chatSocket";

export type NotificationEventType =
  | "chat.message.created"
  | "bill.message.created"
  | "bill_created"
  | "admin_bill_created"
  | "billing.created"
  | "billing.updated"
  | "workTask.created"
  | "workTask.updated"
  | "workTask.completed"
  | "workTask.cancelled"
  | "workTask.cancle"
  | "workTask.hold"
  | "toolRent.created"
  | "toolRent.updated"
  | "toolRent.returnDue"
  | "scheduled.dailyGreeting"
  | "scheduled.festivalGreeting"
  | "daily_good_morning"
  | "hindu_festival_greeting"
  | "system.general";

type NotificationInput = {
  eventType?: string;
  type?: string;
  eventId?: string;
  actorUserId?: string;
  actorId?: string;
  userId?: string;
  userIds?: string[];
  audience?: "admins" | "all" | "customers";
  title?: string;
  body?: string;
  data?: Record<string, any>;
};

type Target = {
  userId: string;
  title: string;
  body: string;
  data: Record<string, any>;
};

const LEGACY_TYPE_MAP: Record<string, NotificationEventType> = {
  customer_created: "system.general",
  cashbook_entry: "system.general",
  inventory_added: "system.general",
  shop_status: "system.general",
  admin_broadcast: "system.general",
  user_direct: "system.general",
  bill_status_updated: "billing.updated",
  "workTask.cancle": "workTask.cancelled",
};

const SUPPORTED = new Set<string>([
  "chat.message.created",
  "bill.message.created",
  "bill_created",
  "admin_bill_created",
  "billing.created",
  "billing.updated",
  "workTask.created",
  "workTask.updated",
  "workTask.completed",
  "workTask.cancelled",
  "workTask.cancle",
  "workTask.hold",
  "toolRent.created",
  "toolRent.updated",
  "toolRent.returnDue",
  "scheduled.dailyGreeting",
  "scheduled.festivalGreeting",
  "daily_good_morning",
  "hindu_festival_greeting",
  "system.general",
]);

function unique(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeEventType(type: string): NotificationEventType {
  const raw = String(type || "system.general").trim();
  if (LEGACY_TYPE_MAP[raw]) return LEGACY_TYPE_MAP[raw];
  if (SUPPORTED.has(raw)) return raw === "workTask.cancle" ? "workTask.cancelled" : (raw as NotificationEventType);
  return "system.general";
}

function stableEventId(input: NotificationInput, normalizedEventType: string) {
  if (input.eventId) return String(input.eventId);
  const data = input.data || {};
  const ids = [
    data.messageId,
    data.billId,
    data.workId,
    data.taskId,
    data.toolRentId,
    data.requestId,
    data.offerId,
    ...(input.userIds || []),
    input.userId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(":");
  const bucket = Math.floor(Date.now() / 60_000);
  return createHash("sha256").update(`${normalizedEventType}:${input.actorUserId || input.actorId || ""}:${ids}:${bucket}`).digest("hex").slice(0, 32);
}

async function getActiveAdmins() {
  const users = await sanityClient.fetch<Array<{ _id: string; name?: string; role?: string }>>(
    `*[_type=="user" && role in ["admin","super_admin","technician"] && isActive != false]{_id,name,role}`,
  );
  return users || [];
}

async function getActiveCustomers() {
  const users = await sanityClient.fetch<Array<{ _id: string; name?: string; role?: string }>>(
    `*[_type=="user" && role=="customer" && isActive != false]{_id,name,role}`,
  );
  return users || [];
}

async function resolveUserIds(ids: string[]) {
  const uniqueIds = unique(ids);
  if (!uniqueIds.length) return [];
  try {
    const resolved = await sanityClient.fetch<string[]>(
      `*[_type=="user" && (_id in $ids || customerId in $ids || clerkId in $ids) && isActive != false]._id`,
      { ids: uniqueIds },
    );
    return unique(resolved || uniqueIds);
  } catch (error) {
    console.warn("[notifications] user id resolution skipped", error instanceof Error ? error.message : error);
    return uniqueIds;
  }
}

async function getRegisteredAudienceUserIds(audience: "admins" | "all" | "customers") {
  const roleFilter =
    audience === "customers"
      ? { role: "customer" }
      : audience === "admins"
        ? { role: { $in: ["admin", "super_admin", "technician"] } }
        : {};
  const ids = await FcmToken.distinct("userId", { isActive: true, ...roleFilter });
  if (ids.length || audience === "all") return unique(ids);
  const fallback = await FcmToken.distinct("userId", { isActive: true });
  console.warn("[notifications] audience role metadata missing; using active token fallback", {
    audience,
    activeTokenUsers: fallback.length,
  });
  return unique(fallback);
}

async function getRegisteredAudienceUsers(audience: "admins" | "all" | "customers") {
  const roleFilter =
    audience === "customers"
      ? { role: "customer" }
      : audience === "admins"
        ? { role: { $in: ["admin", "super_admin", "technician"] } }
        : {};
  let tokens = await FcmToken.find({ isActive: true, ...roleFilter })
    .sort({ updatedAt: -1 })
    .select({ userId: 1, displayName: 1, role: 1 })
    .lean();
  if (!tokens.length && audience !== "all") {
    tokens = await FcmToken.find({ isActive: true })
      .sort({ updatedAt: -1 })
      .select({ userId: 1, displayName: 1, role: 1 })
      .lean();
    console.warn("[notifications] audience role metadata missing; using active token fallback", {
      audience,
      activeTokenUsers: tokens.length,
    });
  }
  const seen = new Set<string>();
  return tokens
    .map((token) => ({
      userId: String(token.userId || "").trim(),
      displayName: String(token.displayName || "").trim(),
    }))
    .filter((token) => {
      if (!token.userId || seen.has(token.userId)) return false;
      seen.add(token.userId);
      return true;
    });
}

function defaultTitleBody(type: NotificationEventType, data: Record<string, any>, input: NotificationInput, receiverUserId: string) {
  const title = String(input.title || "").trim();
  const body = String(input.body || "").trim();
  if (title && body) return { title, body };
  const customerName = String(data.customerName || "customer");
  if (type === "chat.message.created") {
    return { title: `Message from ${data.senderName || "Shop"}`, body: String(data.preview || data.text || "New message") };
  }
  if (type === "bill_created" || type === "billing.created" || type === "bill.message.created") {
    const isCustomer = String(data.customerId || "") === receiverUserId;
    return {
      title: isCustomer ? "Bill created" : `New bill created for ${customerName}`,
      body: isCustomer ? "Your bill has been created." : `New bill created for ${customerName}.`,
    };
  }
  if (type === "admin_bill_created") return { title: "New bill created", body: `New bill created for ${customerName}.` };
  if (type === "billing.updated") return { title: "Bill updated", body: "A bill has been updated." };
  if (type.startsWith("workTask.")) return { title: "Work task update", body: String(data.title || data.message || "A work task was updated.") };
  if (type.startsWith("toolRent.")) return { title: "Tool rent update", body: String(data.title || data.message || "Tool rent update.") };
  if (type.includes("Greeting") || type.includes("good_morning") || type.includes("festival")) {
    return { title: title || "Greetings", body: body || "Best wishes from Jambh Electrics." };
  }
  return { title: title || "Notification", body: body || String(data.message || "You have a new notification.") };
}

async function targetsFor(input: NotificationInput, normalizedEventType: NotificationEventType): Promise<Target[]> {
  const data = input.data || {};
  const actorUserId = String(input.actorUserId || input.actorId || data.actorId || data.actorUserId || "").trim();
  let targetIds: string[] = [];

  if (normalizedEventType === "chat.message.created") {
    targetIds = unique([data.receiverUserId, data.receiverId, ...(input.userIds || []), input.userId]);
  } else if (normalizedEventType === "bill_created" || normalizedEventType === "billing.created" || normalizedEventType === "bill.message.created") {
    const admins = await getActiveAdmins();
    targetIds = unique([data.customerId, input.userId, ...(input.userIds || []), ...admins.map((admin) => admin._id)]);
  } else if (normalizedEventType === "admin_bill_created") {
    const admins = await getActiveAdmins();
    targetIds = unique([...(input.userIds || []), ...admins.map((admin) => admin._id)]);
  } else if (normalizedEventType === "billing.updated") {
    const admins = await getActiveAdmins();
    targetIds = unique([data.customerId, input.userId, ...(input.userIds || []), ...admins.map((admin) => admin._id)]);
  } else if (normalizedEventType.startsWith("workTask.")) {
    targetIds = unique([
      data.customerId,
      data.assignedUserId,
      data.assignedTechnicianId,
      data.technicianId,
      data.adminId,
      ...(Array.isArray(data.assignedUserIds) ? data.assignedUserIds : []),
      ...(input.userIds || []),
      input.userId,
    ]);
  } else if (normalizedEventType.startsWith("toolRent.")) {
    targetIds = unique([data.customerId, data.adminId, data.assignedUserId, ...(input.userIds || []), input.userId]);
  } else if (
    normalizedEventType === "scheduled.dailyGreeting" ||
    normalizedEventType === "daily_good_morning"
  ) {
    const users = await getRegisteredAudienceUsers("all");
    return users
      .filter((user) => user.userId !== actorUserId)
      .map((user) => {
        const name = user.displayName || "there";
        return {
          userId: user.userId,
          title: `Good morning, ${name}`,
          body: `Good morning, ${name}. Have a great day from Jambh Electrics.`,
          data: { ...data, greetingName: name },
        };
      });
  } else if (
    normalizedEventType === "scheduled.festivalGreeting" ||
    normalizedEventType === "hindu_festival_greeting"
  ) {
    targetIds = [];
  } else if (normalizedEventType === "system.general") {
    if (input.audience) targetIds = await getRegisteredAudienceUserIds(input.audience);
    else targetIds = unique([input.userId, ...(input.userIds || []), data.targetUserId, data.customerId]);
  }

  const resolvedIds = await resolveUserIds(targetIds);
  return unique(resolvedIds)
    .filter((id) => id !== actorUserId)
    .map((receiverUserId) => {
      const text = defaultTitleBody(normalizedEventType, data, input, receiverUserId);
      return { userId: receiverUserId, title: text.title, body: text.body, data };
    });
}

function dataPayload(args: {
  type: string;
  eventId: string;
  receiverUserId: string;
  actorUserId: string;
  data: Record<string, any>;
}) {
  return {
    type: args.type,
    eventId: args.eventId,
    userId: args.receiverUserId,
    actorId: args.actorUserId,
    roomId: String(args.data.roomId || ""),
    requestId: String(args.data.requestId || ""),
    billId: String(args.data.billId || ""),
    workId: String(args.data.workId || args.data.taskId || ""),
    toolRentId: String(args.data.toolRentId || args.data.rentalId || ""),
    offerId: String(args.data.offerId || ""),
    route: String(args.data.route || args.data.route_path || ""),
    createdAt: new Date().toISOString(),
  };
}

function isInvalidTokenError(error: any) {
  const code = String(error?.code || error?.errorInfo?.code || "");
  return code.includes("registration-token-not-registered") || code.includes("invalid-registration-token");
}

async function markTokenInvalid(token: string, reason: string) {
  await FcmToken.updateOne(
    { token },
    { $set: { isActive: false, deactivatedAt: new Date(), deactivatedReason: reason } },
  );
}

async function sendToToken(input: {
  token: FcmTokenDoc;
  title: string;
  body: string;
  data: Record<string, string>;
}) {
  const messaging = getFirebaseMessaging();
  if (!messaging) return { ok: false, error: "Firebase Admin is not configured" };
  const messageData: Record<string, string> = {
    ...input.data,
    title: input.title,
    body: input.body,
    notificationTitle: input.title,
    notificationBody: input.body,
  };
  let lastError = "";
  for (let attempt = 1; attempt <= env.notificationRetryAttempts; attempt += 1) {
    try {
      await messaging.send({
        token: input.token.token,
        data: messageData,
        android: {
          priority: "high",
          notification: {
            title: input.title,
            body: input.body,
            channelId: env.fcmAndroidChannelId,
            priority: "high",
            defaultSound: true,
          },
        },
        apns: {
          payload: {
            aps: {
              alert: { title: input.title, body: input.body },
              sound: "default",
              contentAvailable: true,
            },
          },
        },
        webpush: {
          headers: { Urgency: "high" },
          fcmOptions: { link: input.data.route || "/" },
        },
      });
      return { ok: true, attempts: attempt };
    } catch (error: any) {
      lastError = error?.message || String(error);
      console.warn("[notifications] FCM failed", { tokenId: input.token._id, attempt, error: lastError });
      if (isInvalidTokenError(error)) {
        await markTokenInvalid(input.token.token, lastError);
        return { ok: false, attempts: attempt, error: lastError, invalid: true };
      }
      if (attempt < env.notificationRetryAttempts) {
        console.warn("[notifications] retry scheduled", { tokenId: input.token._id, attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  return { ok: false, attempts: env.notificationRetryAttempts, error: lastError || "FCM failed" };
}

async function createSkippedLog(input: {
  eventType: string;
  normalizedEventType: string;
  receiverUserId: string;
  actorUserId: string;
  eventId: string;
  reason: string;
  payload: Record<string, any>;
}) {
  await NotificationLog.updateOne(
    { idempotencyKey: `${input.eventId}:${input.receiverUserId}` },
    {
      $setOnInsert: {
        eventType: input.eventType,
        normalizedEventType: input.normalizedEventType,
        receiverUserId: input.receiverUserId,
        actorUserId: input.actorUserId,
        eventId: input.eventId,
        idempotencyKey: `${input.eventId}:${input.receiverUserId}`,
        payload: input.payload,
        status: "skipped",
        skippedReason: input.reason,
      },
    },
    { upsert: true },
  );
  console.log("[notifications] skipped", input.reason, input.receiverUserId);
}

export async function processNotificationEvent(input: NotificationInput) {
  const eventType = String(input.eventType || input.type || "system.general");
  const normalizedEventType = normalizeEventType(eventType);
  const actorUserId = String(input.actorUserId || input.actorId || input.data?.actorId || input.data?.actorUserId || "").trim();
  const eventId = stableEventId(input, normalizedEventType);
  console.log("[notifications] event received", { eventType, eventId });
  console.log("[notifications] event normalized", { eventType, normalizedEventType });
  const targets = await targetsFor(input, normalizedEventType);
  console.log("[notifications] target users resolved", targets.map((target) => target.userId));

  let deliverableTargets = targets;
  let skippedUnregistered = 0;
  if (input.audience) {
    const targetIds = targets.map((target) => target.userId);
    const registeredIds = await FcmToken.distinct("userId", { userId: { $in: targetIds }, isActive: true });
    const registered = new Set(registeredIds.map((id) => String(id)));
    deliverableTargets = targets.filter((target) => registered.has(target.userId));
    skippedUnregistered = targets.length - deliverableTargets.length;
    console.log("[notifications] unregistered audience users skipped", {
      audience: input.audience,
      skipped: skippedUnregistered,
      deliverable: deliverableTargets.length,
    });
  }

  const results = [];
  for (const target of deliverableTargets) {
    const payload = dataPayload({
      type: normalizedEventType,
      eventId,
      receiverUserId: target.userId,
      actorUserId,
      data: target.data,
    });
    if (target.userId === actorUserId) {
      console.log("[notifications] sender skipped", target.userId);
      await createSkippedLog({ eventType, normalizedEventType, receiverUserId: target.userId, actorUserId, eventId, reason: "sender", payload });
      results.push({ userId: target.userId, status: "skipped", reason: "sender" });
      continue;
    }
    if (normalizedEventType === "chat.message.created" && payload.roomId && isUserActiveInChatRoom(target.userId, payload.roomId)) {
      console.log("[notifications] receiver skipped because active in same chat", target.userId, payload.roomId);
      await createSkippedLog({ eventType, normalizedEventType, receiverUserId: target.userId, actorUserId, eventId, reason: "active_same_chat", payload });
      results.push({ userId: target.userId, status: "skipped", reason: "active_same_chat" });
      continue;
    }
    const tokens = await FcmToken.find({ userId: target.userId, isActive: true }).sort({ updatedAt: -1 });
    if (!tokens.length) {
      console.log("[notifications] token missing", target.userId);
      await createSkippedLog({ eventType, normalizedEventType, receiverUserId: target.userId, actorUserId, eventId, reason: "token_missing", payload });
      results.push({ userId: target.userId, status: "skipped", reason: "token_missing" });
      continue;
    }
    const log = await NotificationLog.findOneAndUpdate(
      { idempotencyKey: `${eventId}:${target.userId}` },
      {
        $setOnInsert: {
          eventType,
          normalizedEventType,
          receiverUserId: target.userId,
          actorUserId,
          eventId,
          idempotencyKey: `${eventId}:${target.userId}`,
          payload,
          status: "pending",
        },
      },
      { new: true, upsert: true, rawResult: true } as any,
    );
    const doc = (log as any).value || log;
    if ((log as any).lastErrorObject?.updatedExisting && doc?.status === "sent") {
      results.push({ userId: target.userId, status: "skipped", reason: "duplicate" });
      continue;
    }

    const deliveries = [];
    let sent = 0;
    for (const token of tokens) {
      const send = await sendToToken({
        token: token as FcmTokenDoc,
        title: target.title,
        body: target.body,
        data: payload,
      });
      if (send.ok) {
        console.log("[notifications] FCM sent", { userId: target.userId, tokenId: token._id });
        sent += 1;
      } else {
        console.warn(send.invalid ? "[notifications] token invalid" : "[notifications] FCM failed", {
          userId: target.userId,
          tokenId: token._id,
          error: send.error,
        });
      }
      deliveries.push({
        tokenId: String(token._id),
        token: String(token.token).slice(0, 16),
        deviceId: token.deviceId || "",
        status: send.ok ? "sent" : "failed",
        failureReason: send.ok ? "" : send.error || "FCM failed",
        attempts: send.attempts || 1,
        sentAt: send.ok ? new Date() : null,
      });
    }
    const status = sent > 0 ? "sent" : "failed";
    const failureReason = sent > 0 ? "" : deliveries.map((delivery) => delivery.failureReason).filter(Boolean).join(" | ");
    await NotificationLog.updateOne(
      { idempotencyKey: `${eventId}:${target.userId}` },
      {
        $set: {
          status,
          deliveries,
          sentAt: sent > 0 ? new Date() : null,
          failureReason,
        },
      },
    );
    results.push({
      userId: target.userId,
      status,
      sent,
      failureReason,
      deliveries: deliveries.map((delivery) => ({
        deviceId: delivery.deviceId,
        status: delivery.status,
        failureReason: delivery.failureReason,
        attempts: delivery.attempts,
      })),
    });
  }

  return { ok: true, eventId, eventType, normalizedEventType, skippedUnregistered, results };
}

async function allowedDevicesFor(userId: string) {
  const setting = await NotificationDeviceSetting.findOne({ userId }).lean();
  const count = Number(setting?.allowedDevicesCount || 1);
  return Math.min(2, Math.max(1, Number.isFinite(count) ? Math.trunc(count) : 1));
}

export async function registerNotificationToken(input: {
  userId: string;
  token: string;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  role?: string;
  displayName?: string;
}) {
  const userId = (await resolveUserIds([input.userId]))[0] || input.userId;
  const now = new Date();
  const token = await FcmToken.findOneAndUpdate(
    { token: input.token },
    {
      $set: {
        userId,
        token: input.token,
        deviceId: input.deviceId || "",
        deviceName: input.deviceName || "",
        platform: input.platform || "",
        role: input.role || "",
        displayName: input.displayName || "",
        isActive: true,
        lastSeen: now,
        deactivatedAt: null,
        deactivatedReason: "",
      },
    },
    { new: true, upsert: true },
  );
  const allowed = await allowedDevicesFor(userId);
  const active = await FcmToken.find({ userId, isActive: true }).sort({ updatedAt: -1 });
  const stale = active.slice(allowed);
  for (const old of stale) {
    await FcmToken.updateOne(
      { _id: old._id },
      { $set: { isActive: false, deactivatedAt: now, deactivatedReason: "DEVICE_LIMIT_EXCEEDED" } },
    );
    if (old.deviceId) {
      emitDeviceRevoked({
        userId,
        deviceId: old.deviceId,
        reason: "DEVICE_LIMIT_EXCEEDED",
        loggedInOn: input.deviceName || input.platform || "another device",
      });
    }
  }
  return { userId, tokenId: String(token._id), allowedDevicesCount: allowed, removedTokens: stale.length };
}

export async function removeNotificationToken(input: { userId?: string; token: string }) {
  const filter: any = { token: input.token };
  if (input.userId) filter.userId = input.userId;
  await FcmToken.updateMany(filter, {
    $set: { isActive: false, deactivatedAt: new Date(), deactivatedReason: "USER_REMOVED" },
  });
  return { ok: true };
}

export async function updateDeviceSetting(input: { userId: string; allowedDevicesCount: number }) {
  const userId = (await resolveUserIds([input.userId]))[0] || input.userId;
  const allowedDevicesCount = Math.min(2, Math.max(1, Math.trunc(Number(input.allowedDevicesCount || 1))));
  await NotificationDeviceSetting.updateOne(
    { userId },
    { $set: { userId, allowedDevicesCount } },
    { upsert: true },
  );
  return { userId, allowedDevicesCount };
}
