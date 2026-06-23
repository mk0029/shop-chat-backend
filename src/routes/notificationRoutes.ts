import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { requireShopAuth, type AuthRequest } from "../middleware/auth";
import { NotificationLog } from "../models/NotificationLog";
import { FcmToken } from "../models/FcmToken";
import {
  createAndDispatchNotification,
  registerNotificationToken,
  removeNotificationToken,
  updateDeviceSetting,
} from "../services/notificationCenter";
import { dispatchNotificationBackground, getNotificationQueueStats } from "../services/notificationDispatcher";
import { notificationLogger } from "../lib/notificationLogger";

const router = Router();

function hasInternalSecret(req: AuthRequest) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const header = String(req.headers["x-notify-secret"] || "");
  const token = bearer || header;
  return Boolean(env.chatSyncToken && token && token === env.chatSyncToken);
}

function requireNotificationAccess(req: AuthRequest, res: any, next: any) {
  if (hasInternalSecret(req)) return next();
  return requireShopAuth(req, res, next);
}

const registerTokenSchema = z.object({
  userId: z.string().trim().min(1),
  token: z.string().trim().min(1),
  deviceId: z.string().trim().optional(),
  deviceName: z.string().trim().optional(),
  platform: z.string().trim().optional(),
  role: z.string().trim().optional(),
  displayName: z.string().trim().optional(),
  name: z.string().trim().optional(),
  deviceInfo: z
    .object({
      deviceId: z.string().trim().optional(),
      deviceName: z.string().trim().optional(),
      platform: z.string().trim().optional(),
      role: z.string().trim().optional(),
      displayName: z.string().trim().optional(),
      name: z.string().trim().optional(),
      browser: z.string().trim().optional(),
      os: z.string().trim().optional(),
    })
    .passthrough()
    .optional(),
});

router.post("/register-token", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const input = registerTokenSchema.parse(req.body || {});
    const deviceInfo = input.deviceInfo || {};
    const result = await registerNotificationToken({
      userId: input.userId,
      token: input.token,
      deviceId: input.deviceId || deviceInfo.deviceId,
      deviceName: input.deviceName || deviceInfo.deviceName || deviceInfo.browser || deviceInfo.os,
      platform: input.platform || deviceInfo.platform,
      role: input.role || deviceInfo.role,
      displayName: input.displayName || input.name || deviceInfo.displayName || deviceInfo.name,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.post("/register-device", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const input = z
      .object({
        userId: z.string().trim().min(1),
        deviceInfo: z.object({ deviceId: z.string().trim().min(1) }).passthrough(),
      })
      .parse(req.body || {});
    res.json({
      success: true,
      data: {
        userId: input.userId,
        deviceId: input.deviceInfo.deviceId,
        allowedDevicesCount: 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/device-status", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ userId: z.string().trim().min(1), deviceId: z.string().trim().min(1) }).parse(req.body || {});
    const current = await FcmToken.findOne({ userId: input.userId, deviceId: input.deviceId }).sort({ updatedAt: -1 }).lean();
    if (!current) return res.json({ success: true, known: false, active: true });
    res.json({
      success: true,
      known: true,
      active: current.deactivatedReason === "FCM_TOKEN_REFRESH" ? true : current.isActive !== false,
      reason: current.deactivatedReason,
      deviceName: current.deviceName,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/remove-token", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ userId: z.string().optional(), token: z.string().min(1) }).parse(req.body || {});
    const result = await removeNotificationToken(input);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.post("/emit", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    dispatchNotificationBackground(req.body || {});
    res.json({ success: true, queued: true, message: "Notification queued for background processing" });
  } catch (error) {
    next(error);
  }
});

router.post("/test-send", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const body = req.body || {};
    const result = await createAndDispatchNotification({
      eventType: body.eventType || "system.general",
      eventId: body.eventId || `test.${Date.now()}`,
      actorUserId: req.shopUser?.id || body.actorUserId || "system",
      userId: body.userId,
      userIds: body.userIds,
      audience: body.audience,
      title: body.title || "Test notification",
      body: body.body || "This is a backend FCM test.",
      data: body.data || {},
    });
    res.json({ success: result.ok, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/logs", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
    const status = String(req.query.status || "");
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (req.query.eventId) filter.eventId = String(req.query.eventId);
    if (req.query.userId) filter.receiverUserId = String(req.query.userId);
    const logs = await NotificationLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, logs });
  } catch (error) {
    next(error);
  }
});

router.patch("/users/notification-device-setting", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const input = z
      .object({
        userId: z.string().trim().min(1),
        allowedDevicesCount: z.number().or(z.string()).transform(Number),
      })
      .parse(req.body || {});
    const result = await updateDeviceSetting(input);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get("/queue/stats", requireNotificationAccess, async (_req: AuthRequest, res, next) => {
  try {
    const stats = getNotificationQueueStats();
    res.json({ success: true, stats });
  } catch (error) {
    next(error);
  }
});

router.get("/logs/recent", requireNotificationAccess, async (req: AuthRequest, res, next) => {
  try {
    const count = Math.max(1, Math.min(200, Number(req.query.count || 50)));
    const logs = notificationLogger.getRecentLogs(count);
    res.json({ success: true, logs });
  } catch (error) {
    next(error);
  }
});

export default router;
