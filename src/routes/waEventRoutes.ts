import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { WaEventLog } from "../models/WaEventLog";
import { waClient } from "../services/whatsapp/waClient.service";
import { waEventRouter } from "../services/whatsapp/waEventRouter.service";
import { waLogger } from "../services/whatsapp/waLogger.service";
import { waQueue } from "../services/whatsapp/waQueue.service";
import { normalizePhoneList } from "../services/whatsapp/waPhone.utils";
import { waIdempotency } from "../services/whatsapp/waIdempotency.service";
import type { WaEventType } from "../services/whatsapp/waTemplates.service";

const router = Router();

function hasEventSecret(req: any) {
  if (!env.waEventSecret) return true;
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const header = String(req.headers["x-wa-event-secret"] || req.headers["x-notify-secret"] || "");
  return [bearer, header].filter(Boolean).includes(env.waEventSecret);
}

router.use((req, res, next) => {
  if (hasEventSecret(req)) return next();
  return res.status(401).json({ success: false, message: "Unauthorized WhatsApp event" });
});

const baseSchema = z.object({
  idempotencyKey: z.string().trim().optional(),
  eventId: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  customerPhone: z.string().trim().optional(),
  notifyAdmins: z.boolean().optional(),
  adminPhones: z.array(z.string().trim()).optional(),
}).passthrough();

const schemas: Record<WaEventType, z.ZodTypeAny> = {
  "customer-created": baseSchema.extend({
    customerId: z.string().trim().min(1),
    customerName: z.string().trim().optional(),
    secretKey: z.string().trim().optional(),
    loginUrl: z.string().trim().url().optional(),
  }),
  "bill-created": baseSchema.extend({ billId: z.string().trim().min(1), billNumber: z.string().trim().optional() }),
  "bill-updated": baseSchema.extend({ billId: z.string().trim().min(1), updatedAt: z.string().trim().optional() }),
  "bill-deleted": baseSchema.extend({ billId: z.string().trim().min(1), reason: z.string().trim().optional() }),
  "work-request-created": baseSchema.extend({ requestId: z.string().trim().min(1), title: z.string().trim().min(1) }),
  "work-request-updated": baseSchema.extend({ requestId: z.string().trim().min(1), title: z.string().trim().optional(), status: z.string().trim().optional(), updatedAt: z.string().trim().optional() }),
  "work-request-done": baseSchema.extend({ requestId: z.string().trim().min(1), title: z.string().trim().optional(), completedAt: z.string().trim().optional() }),
  "work-request-cancelled": baseSchema.extend({ requestId: z.string().trim().min(1), title: z.string().trim().optional(), cancellationReason: z.string().trim().optional() }),
};

function eventRoute(eventType: WaEventType) {
  return async (req: any, res: any, next: any) => {
    try {
      const payload = schemas[eventType].parse(req.body || {});
      const result = await waEventRouter.handle(eventType, payload);
      res.status(result.skipped ? 200 : 202).json(result);
    } catch (error) {
      next(error);
    }
  };
}


const sendSchema = z.object({
  to: z.union([z.string().trim(), z.array(z.string().trim())]),
  message: z.string().trim().min(1).max(4000),
  eventType: z.string().trim().default("custom.whatsapp"),
  eventId: z.string().trim().optional(),
  idempotencyKey: z.string().trim().optional(),
  metadata: z.record(z.unknown()).optional(),
});

router.post("/send", async (req, res, next) => {
  try {
    const input = sendSchema.parse(req.body || {});
    const phones = Array.isArray(input.to) ? input.to : [input.to];
    const eventId = input.eventId || `custom:${Date.now()}`;
    const idempotencyKey = input.idempotencyKey || `${input.eventType}:${eventId}:${phones.join(",")}`;
    waLogger.eventReceived(input.eventType, eventId, idempotencyKey);
    waLogger.payloadValidated(input.eventType, idempotencyKey);
    const reserved = await waIdempotency.reserve({
      eventType: input.eventType,
      eventId,
      idempotencyKey,
      payload: { to: phones, metadata: input.metadata || {} },
    });
    if (reserved.duplicate) {
      return res.json({ success: true, skipped: true, duplicate: true, idempotencyKey, eventId });
    }
    const { jids, skipped } = normalizePhoneList(phones);
    if (!jids.length) {
      await waIdempotency.markSkipped(idempotencyKey, "phone_missing_or_invalid");
      return res.json({ success: true, skipped: true, reason: "phone_missing_or_invalid", invalidPhones: skipped });
    }
    const results = jids.map((jid) => {
      waLogger.phoneNormalized(jid, jid, idempotencyKey);
      const job = waQueue.enqueue({ eventType: input.eventType, eventId, idempotencyKey, jid, text: input.message });
      return { queued: true, jobId: job.id, jid };
    });
    res.status(202).json({ success: true, queued: true, eventId, idempotencyKey, recipients: jids.length, invalidPhones: skipped, results });
  } catch (error) {
    next(error);
  }
});
router.post("/events/customer-created", eventRoute("customer-created"));
router.post("/events/bill-created", eventRoute("bill-created"));
router.post("/events/bill-updated", eventRoute("bill-updated"));
router.post("/events/bill-deleted", eventRoute("bill-deleted"));
router.post("/events/work-request-created", eventRoute("work-request-created"));
router.post("/events/work-request-updated", eventRoute("work-request-updated"));
router.post("/events/work-request-done", eventRoute("work-request-done"));
router.post("/events/work-request-cancelled", eventRoute("work-request-cancelled"));

router.get("/status", (_req, res) => {
  res.json({ success: true, bot: waClient.getStatus(), queue: waQueue.getStats() });
});

router.get("/logs/recent", (req, res) => {
  res.json({ success: true, logs: waLogger.getRecentLogs(Number(req.query.count || 100)) });
});

router.get("/events/logs", async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
    const logs = await WaEventLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, logs });
  } catch (error) {
    next(error);
  }
});

export default router;

