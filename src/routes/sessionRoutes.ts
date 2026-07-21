import { Router } from "express";
import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env";
import { emitDeviceRevoked } from "../sockets/chatSocket";
import { Session } from "../models/Session";

const router = Router();

const sessionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many session requests. Please slow down." },
});

function hasInternalAccess(req: Request) {
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return Boolean(env.chatSyncToken && token && token === env.chatSyncToken);
}

router.post("/session/create", sessionRateLimiter, async (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const { sessionId, userId, deviceId, deviceName, browser, os } = req.body || {};
  if (!sessionId || !userId) {
    return res.status(400).json({ ok: false, message: "Missing sessionId or userId" });
  }

  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          sessionId,
          userId,
          deviceId: String(deviceId || "").slice(0, 200),
          deviceName: String(deviceName || "").slice(0, 200),
          browser: String(browser || "").slice(0, 100),
          os: String(os || "").slice(0, 100),
          status: "active",
          issuedAt: now,
          lastSeenAt: now,
          expiresAt,
        },
      },
      { new: true, upsert: true },
    );

    return res.json({ ok: true, sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server error";
    return res.status(500).json({ ok: false, message });
  }
});

router.post("/session/replace", sessionRateLimiter, async (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const { userId, newSessionId, newDeviceName } = req.body || {};
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Missing userId" });
  }

  try {
    const active = await Session.find({ userId, status: "active" })
      .sort({ lastSeenAt: -1 })
      .lean();

    if (!active.length) {
      return res.json({ ok: true, replacedCount: 0 });
    }

    const now = new Date();
    let replacedCount = 0;

    for (const session of active) {
      if (newSessionId && session.sessionId === newSessionId) continue;

      await Session.updateOne(
        { _id: session._id },
        {
          $set: {
            status: "replaced",
            replacedBySessionId: newSessionId || null,
            replacedAt: now,
            replacedByDeviceName: newDeviceName || "another device",
          },
        },
      );

      const emitted = emitDeviceRevoked({
        userId,
        deviceId: session.deviceId || undefined,
        sessionId: session.sessionId,
        reason: "LOGGED_IN_ON_ANOTHER_DEVICE",
        loggedInOn: newDeviceName || session.deviceName || "another device",
        message: "Your session was replaced because you logged in on another device.",
      });

      if (emitted) replacedCount += 1;
    }

    return res.json({ ok: true, replacedCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server error";
    return res.status(500).json({ ok: false, message });
  }
});

router.post("/session/heartbeat", sessionRateLimiter, async (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ ok: false, message: "Missing sessionId" });
  }

  try {
    await Session.updateOne({ sessionId }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
  }
});

router.post("/session/logout", sessionRateLimiter, async (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const { sessionId, userId } = req.body || {};
  if (!sessionId && !userId) {
    return res.status(400).json({ ok: false, message: "Missing sessionId or userId" });
  }

  try {
    let filter: Record<string, unknown> = {};
    if (sessionId) filter.sessionId = sessionId;
    else if (userId) filter = { userId, status: "active" };

    await Session.updateMany(filter, {
      $set: { status: "logged_out", lastSeenAt: new Date() },
    });

    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.get("/session/status", sessionRateLimiter, async (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const sessionId = String(req.query.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, message: "Missing sessionId" });
  }

  try {
    const session = await Session.findOne({ sessionId }).lean();
    if (!session) {
      return res.json({ ok: true, known: false });
    }
    return res.json({
      ok: true,
      known: true,
      status: session.status,
      userId: session.userId,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      issuedAt: session.issuedAt,
      lastSeenAt: session.lastSeenAt,
    });
  } catch {
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.post("/session/revoke", sessionRateLimiter, async (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const userId = String(req.body?.userId || "").trim().slice(0, 200);
  const deviceId = String(req.body?.deviceId || "").trim().slice(0, 200);
  const sessionId = String(req.body?.sessionId || "").trim().slice(0, 200);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Missing userId" });
  }

  const emitted = emitDeviceRevoked({
    userId,
    deviceId: deviceId || undefined,
    sessionId: sessionId || undefined,
    reason: String(req.body?.reason || "DEVICE_LIMIT_EXCEEDED").slice(0, 100),
    loggedInOn: req.body?.loggedInOn ? String(req.body.loggedInOn).slice(0, 100) : undefined,
    message: req.body?.message ? String(req.body.message).slice(0, 500) : undefined,
  });

  return res.json({ ok: true, emitted });
});

router.get("/sessions", sessionRateLimiter, async (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const userId = String(req.query.userId || "").trim();
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Missing userId" });
  }

  try {
    const sessions = await Session.find({ userId }).sort({ lastSeenAt: -1 }).limit(20).lean();
    return res.json({ ok: true, sessions });
  } catch {
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

export default router;
