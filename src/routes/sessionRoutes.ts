import { Router } from "express";
import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env";
import { emitDeviceRevoked } from "../sockets/chatSocket";

const router = Router();

const sessionRevokeLimiter = rateLimit({
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

router.post("/session/revoke", sessionRevokeLimiter, (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const userId = String(req.body?.userId || "").trim().slice(0, 200);
  const deviceId = String(req.body?.deviceId || "").trim().slice(0, 200);
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Missing userId" });
  }

  const emitted = emitDeviceRevoked({
    userId,
    deviceId: deviceId || undefined,
    reason: String(req.body?.reason || "DEVICE_LIMIT_EXCEEDED").slice(0, 100),
    loggedInOn: req.body?.loggedInOn ? String(req.body.loggedInOn).slice(0, 100) : undefined,
    message: req.body?.message ? String(req.body.message).slice(0, 500) : undefined,
  });

  return res.json({ ok: true, emitted });
});

export default router;
