import { env } from "../../config/env";

export type WaEventType =
  | "customer-created"
  | "bill-created"
  | "bill-updated"
  | "bill-deleted"
  | "work-request-created"
  | "work-request-updated"
  | "work-request-done"
  | "work-request-cancelled";

export type TemplateContext = Record<string, any>;

function money(value: unknown) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "";
  return `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function value(input: TemplateContext, key: string, fallback = "") {
  const v = input[key];
  return v === undefined || v === null || v === "" ? fallback : String(v);
}

function billLines(input: TemplateContext) {
  const lines = [
    `Bill: ${value(input, "billNumber", value(input, "billId", "-"))}`,
    `Total: ${money(input.totalAmount)}`,
  ];
  if (input.paidAmount !== undefined) lines.push(`Paid: ${money(input.paidAmount)}`);
  if (input.balanceAmount !== undefined) lines.push(`Balance: ${money(input.balanceAmount)}`);
  if (input.paymentStatus) lines.push(`Payment: ${input.paymentStatus}`);
  if (input.status) lines.push(`Status: ${input.status}`);
  if (input.dueDate) lines.push(`Due: ${new Date(input.dueDate).toLocaleDateString("en-IN")}`);
  return lines.join("\n");
}

const templates: Record<WaEventType, (input: TemplateContext) => string> = {
  "customer-created": (input) => [
    `Namaste ${value(input, "customerName", "Customer")}, welcome to ${env.waAppName}.`,
    `Login: ${value(input, "loginUrl", env.waLoginUrl)}`,
    input.secretKey ? `Your login/secret key: ${input.secretKey}` : "Use your registered phone/login details to access bills and requests.",
    "You can check bills, work updates, and shop messages from the app.",
    "Hindi: App me login karke apne bill aur work updates dekh sakte hain.",
  ].join("\n"),
  "bill-created": (input) => [`Hello ${value(input, "customerName", "Customer")}, your bill has been created.`, billLines(input), `Open app: ${env.waLoginUrl}`].join("\n"),
  "bill-updated": (input) => [`Hello ${value(input, "customerName", "Customer")}, your bill has been updated.`, billLines(input), `Open app: ${env.waLoginUrl}`].join("\n"),
  "bill-deleted": (input) => [`Hello ${value(input, "customerName", "Customer")}, your bill has been cancelled/deleted.`, `Bill: ${value(input, "billNumber", value(input, "billId", "-"))}`, input.reason ? `Reason: ${input.reason}` : "Please contact the shop for details."].join("\n"),
  "work-request-created": (input) => [`Work request created: ${value(input, "title", "Work request")}`, `Customer: ${value(input, "customerName", "Customer")}`, `Status: ${value(input, "status", "pending")}`, input.dueAt ? `Due: ${new Date(input.dueAt).toLocaleString("en-IN")}` : "", input.assignedTechnicianName ? `Technician: ${input.assignedTechnicianName}` : ""].filter(Boolean).join("\n"),
  "work-request-updated": (input) => [`Work request updated: ${value(input, "title", "Work request")}`, `Status: ${value(input, "status", "updated")}`, input.description ? `Details: ${input.description}` : "", input.assignedTechnicianName ? `Technician: ${input.assignedTechnicianName}` : ""].filter(Boolean).join("\n"),
  "work-request-done": (input) => [`Work request completed: ${value(input, "title", "Work request")}`, input.completionNotes ? `Notes: ${input.completionNotes}` : "Thank you. Please contact us if any issue remains."].filter(Boolean).join("\n"),
  "work-request-cancelled": (input) => [`Work request cancelled: ${value(input, "title", "Work request")}`, input.cancellationReason ? `Reason: ${input.cancellationReason}` : "Please contact the shop for details."].join("\n"),
};

export function renderWaTemplate(eventType: WaEventType, input: TemplateContext) {
  const renderer = templates[eventType];
  if (!renderer) throw new Error(`No WhatsApp template found for ${eventType}`);
  return renderer(input).replace(/\n{3,}/g, "\n\n").trim();
}
