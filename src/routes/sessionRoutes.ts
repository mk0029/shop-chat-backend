import { Router } from "express";
import type { Request } from "express";
import { env } from "../config/env";
import { emitDeviceRevoked } from "../sockets/chatSocket";

const router = Router();

function hasInternalAccess(req: Request) {
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return Boolean(env.chatSyncToken && token && token === env.chatSyncToken);
}

router.post("/session/revoke", (req, res) => {
  if (!hasInternalAccess(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const userId = String(req.body?.userId || "").trim();
  const deviceId = String(req.body?.deviceId || "").trim();
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Missing userId" });
  }

  const emitted = emitDeviceRevoked({
    userId,
    deviceId: deviceId || undefined,
    reason: String(req.body?.reason || "DEVICE_LIMIT_EXCEEDED"),
    loggedInOn: req.body?.loggedInOn ? String(req.body.loggedInOn) : undefined,
    message: req.body?.message ? String(req.body.message) : undefined,
  });

  return res.json({ ok: true, emitted });
});

export default router;
