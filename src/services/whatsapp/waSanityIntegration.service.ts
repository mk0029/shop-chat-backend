import { waEventRouter, type WaEventPayload } from "./waEventRouter.service";
import type { WaEventType } from "./waTemplates.service";

export async function dispatchBackendWaEvent(eventType: WaEventType, payload: WaEventPayload) {
  return waEventRouter.handle(eventType, payload);
}

export function mapSanityDocumentToWaEvent(doc: Record<string, any>, operation: string): { eventType: WaEventType; payload: WaEventPayload } | null {
  const op = String(operation || "").toLowerCase();
  if (doc?._type === "user" && op === "create" && doc.role === "customer") {
    return {
      eventType: "customer-created",
      payload: {
        customerId: doc._id || doc.customerId,
        customerName: doc.name,
        customerPhone: doc.phone,
        secretKey: doc.secretKey,
        eventId: doc._id,
        idempotencyKey: `customerCreated:${doc._id || doc.customerId}`,
      },
    };
  }
  if (doc?._type === "bill") {
    const deleted = op === "delete" || doc.status === "cancelled";
    const created = op === "create" || (doc._createdAt && doc._updatedAt && doc._createdAt === doc._updatedAt);
    const eventType: WaEventType = deleted ? "bill-deleted" : created ? "bill-created" : "bill-updated";
    return {
      eventType,
      payload: {
        billId: doc._id || doc.billId,
        billNumber: doc.billNumber,
        customerId: doc.customer?._ref || doc.customer?._id || doc.customerId,
        customerName: doc.customer?.name || doc.customerName,
        customerPhone: doc.customer?.phone || doc.customerPhone,
        totalAmount: doc.totalAmount,
        paidAmount: doc.paidAmount,
        balanceAmount: doc.balanceAmount,
        paymentStatus: doc.paymentStatus,
        status: doc.status,
        dueDate: doc.dueDate,
        updatedAt: doc.updatedAt || doc._updatedAt,
        eventId: doc._id || doc.billId,
      },
    };
  }
  if (doc?._type === "workTask") {
    const status = String(doc.status || "").toLowerCase();
    const created = op === "create" || (doc._createdAt && doc._updatedAt && doc._createdAt === doc._updatedAt);
    const eventType: WaEventType = status === "completed" ? "work-request-done" : status === "cancelled" ? "work-request-cancelled" : created ? "work-request-created" : "work-request-updated";
    return {
      eventType,
      payload: {
        requestId: doc._id || doc.requestId || doc.taskId,
        title: doc.title,
        description: doc.description,
        customerId: doc.customerRef?._ref || doc.customerRef?._id || doc.customerId,
        customerName: doc.customerName,
        customerPhone: doc.customerPhone,
        technicianId: doc.assignedTechnician?._ref || doc.assignedTechnician?._id,
        technicianPhone: doc.assignedTechnician?.phone,
        assignedTechnicianName: doc.assignedTechnicianName,
        priority: doc.priority,
        status: doc.status,
        dueAt: doc.dueAt,
        updatedAt: doc.updatedAt || doc._updatedAt,
        completedAt: doc.completedAt,
        completionNotes: doc.completionNotes,
        cancellationReason: doc.cancellationReason,
        eventId: doc._id || doc.requestId || doc.taskId,
      },
    };
  }
  return null;
}
