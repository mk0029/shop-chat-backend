import { createHash } from "crypto";
import { env } from "../../config/env";
import { sanityClient } from "../../config/sanity";
import { waIdempotency } from "./waIdempotency.service";
import { waLogger } from "./waLogger.service";
import { waMessageService } from "./waMessage.service";
import { normalizePhoneList, normalizePhoneToJid } from "./waPhone.utils";
import type { WaEventType } from "./waTemplates.service";

export type WaEventPayload = Record<string, any> & {
  idempotencyKey?: string;
  eventId?: string;
  phone?: string;
  customerPhone?: string;
  adminPhones?: string[];
  technicianPhone?: string;
};

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 16);
}

function eventIdFor(eventType: WaEventType, payload: WaEventPayload) {
  return String(payload.eventId || payload.customerId || payload.billId || payload.requestId || payload.taskId || `${eventType}:${stableHash(payload)}`);
}

function idempotencyKeyFor(eventType: WaEventType, payload: WaEventPayload, eventId: string) {
  if (payload.idempotencyKey) return String(payload.idempotencyKey);
  if (eventType === "customer-created") return `customerCreated:${payload.customerId || eventId}`;
  if (eventType === "bill-created") return `billCreated:${payload.billId || eventId}`;
  if (eventType === "bill-updated") return `billUpdated:${payload.billId || eventId}:${payload.updatedAt || payload._updatedAt || stableHash(payload)}`;
  if (eventType === "bill-deleted") return `billDeleted:${payload.billId || eventId}`;
  if (eventType === "work-request-created") return `workRequestCreated:${payload.requestId || payload.taskId || eventId}`;
  if (eventType === "work-request-updated") return `workRequestUpdated:${payload.requestId || payload.taskId || eventId}:${payload.status || "updated"}:${payload.updatedAt || payload._updatedAt || stableHash(payload)}`;
  if (eventType === "work-request-done") return `workRequestDone:${payload.requestId || payload.taskId || eventId}:${payload.updatedAt || payload.completedAt || stableHash(payload)}`;
  if (eventType === "work-request-cancelled") return `workRequestCancelled:${payload.requestId || payload.taskId || eventId}:${payload.updatedAt || stableHash(payload)}`;
  return `${eventType}:${eventId}`;
}

function adminPhonesFromEnv() {
  return env.waAdminPhones.split(/[;,]/).map((value) => value.trim()).filter(Boolean);
}

async function fetchUserPhones(ids: Array<unknown>) {
  const userIds = ids.map((id) => String(id || "").trim()).filter(Boolean);
  if (!userIds.length) return [];
  try {
    const users = await sanityClient.fetch<Array<{ phone?: string }>>(
      `*[_type=="user" && (_id in $ids || customerId in $ids || clerkId in $ids)]{phone}`,
      { ids: userIds },
    );
    return (users || []).map((user) => user.phone).filter(Boolean) as string[];
  } catch (error) {
    waLogger.log("warn", "recipient lookup failed", { details: { error: error instanceof Error ? error.message : String(error) } });
    return [];
  }
}

async function recipientPhonesFor(eventType: WaEventType, payload: WaEventPayload) {
  const directCustomerPhones = [payload.phone, payload.customerPhone, payload.customer?.phone, payload.customer?.mobile];
  const adminPhones = [...(Array.isArray(payload.adminPhones) ? payload.adminPhones : []), ...adminPhonesFromEnv()];
  const technicianPhones = [payload.technicianPhone, payload.technician?.phone, payload.assignedTechnician?.phone];
  const fetchedCustomerPhones = await fetchUserPhones([payload.customerId, payload.customer?._id, payload.customer?._ref]);
  const fetchedTechPhones = await fetchUserPhones([payload.technicianId, payload.assignedTechnicianId, payload.assignedTechnician?._id, payload.assignedTechnician?._ref]);

  if (eventType.startsWith("bill-") || eventType === "customer-created") {
    return [...directCustomerPhones, ...fetchedCustomerPhones, ...adminPhones.filter(() => Boolean(payload.notifyAdmins))];
  }
  if (eventType === "work-request-created" || eventType === "work-request-updated") {
    return [...directCustomerPhones, ...fetchedCustomerPhones, ...technicianPhones, ...fetchedTechPhones, ...adminPhones];
  }
  if (eventType === "work-request-done" || eventType === "work-request-cancelled") {
    return [...directCustomerPhones, ...fetchedCustomerPhones, ...adminPhones];
  }
  return directCustomerPhones;
}

class WaEventRouterService {
  async handle(eventType: WaEventType, payload: WaEventPayload) {
    const eventId = eventIdFor(eventType, payload);
    const idempotencyKey = idempotencyKeyFor(eventType, payload, eventId);
    waLogger.eventReceived(eventType, eventId, idempotencyKey);
    waLogger.payloadValidated(eventType, idempotencyKey);

    const reserved = await waIdempotency.reserve({ eventType, eventId, idempotencyKey, payload });
    if (reserved.duplicate) {
      return { success: true, duplicate: true, skipped: true, reason: "duplicate", idempotencyKey, eventId };
    }

    const phones = await recipientPhonesFor(eventType, payload);
    const { jids, skipped } = normalizePhoneList(phones);
    for (const jid of jids) waLogger.phoneNormalized(jid, jid, idempotencyKey);
    if (!jids.length) {
      const first = phones[0];
      const normalized = normalizePhoneToJid(first);
      const reason = normalized.ok ? "no_recipient" : normalized.reason;
      await waIdempotency.markSkipped(idempotencyKey, reason);
      waLogger.log("warn", "phone missing or invalid; skipped safely", { eventType, eventId, idempotencyKey, details: { skipped, phones: phones.length } });
      return { success: true, skipped: true, reason, idempotencyKey, eventId, invalidPhones: skipped };
    }

    const results = [];
    for (const jid of jids) {
      results.push(await waMessageService.sendEventMessage({ eventType, eventId, idempotencyKey, jid, payload }));
    }
    return { success: true, queued: true, eventType, eventId, idempotencyKey, recipients: jids.length, invalidPhones: skipped, results };
  }
}

export const waEventRouter = new WaEventRouterService();
