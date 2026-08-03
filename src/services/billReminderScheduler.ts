import { sanityClient } from "../config/sanity";
import { env } from "../config/env";
import { sendWaText, isWaConfigured } from "./whatsappSend";

type BillDoc = {
  _id: string;
  billNumber?: string;
  status?: string;
  paymentStatus?: string;
  totalAmount?: number;
  paidAmount?: number;
  balanceAmount?: number;
  dueDate?: string;
  createdAt?: string;
  lastReminderSentAt?: string;
  reminderCount?: number;
  customer?: {
    _id: string;
    name?: string;
    nickname?: string;
    phone?: string;
    allowDueReminder?: boolean;
  };
};

type ReminderSettings = {
  enabled: boolean;
  gapDays: number;
  minimumAmount: number;
  sendHour: number;
  sendMinute: number;
  timezone: string;
};

let schedulerStarted = false;
let timer: NodeJS.Timeout | null = null;
const sentToday = new Set<string>();

const DEFAULT_SETTINGS: ReminderSettings = {
  enabled: true,
  gapDays: 7,
  minimumAmount: 0,
  sendHour: 10,
  sendMinute: 0,
  timezone: "Asia/Kolkata",
};

function indianDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.notificationGreetingTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: env.notificationGreetingTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value || 0),
    minute: Number(parts.find((p) => p.type === "minute")?.value || 0),
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

function pendingAmount(bill: BillDoc): number {
  const balance = typeof bill.balanceAmount === "number" ? bill.balanceAmount : null;
  if (balance !== null) return Math.max(0, balance);
  return Math.max(0, (bill.totalAmount || 0) - (bill.paidAmount || 0));
}

function isEligibleBill(bill: BillDoc): boolean {
  const ps = String(bill.paymentStatus || "").toLowerCase();
  const st = String(bill.status || "").toLowerCase();
  if (["paid", "cancelled", "deleted", "draft", "refunded", "archived"].includes(ps)) return false;
  if (["cancelled", "deleted", "draft", "archived"].includes(st)) return false;
  return pendingAmount(bill) > 0;
}

function formatMoney(value: number): string {
  return `\u20b9${value.toLocaleString("en-IN")}`;
}

function formatDate(value?: string): string {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(d);
}

function buildReminderMessage(bill: BillDoc): string {
  const customer = bill.customer;
  const name = String(customer?.nickname || customer?.name || "Customer").trim() || "Customer";
  const billLabel = bill.billNumber || bill._id;
  const amount = formatMoney(pendingAmount(bill));
  const due = formatDate(bill.dueDate);

  return [
    "Payment Reminder",
    "",
    `Dear ${name},`,
    "",
    "This is a friendly reminder that you have an outstanding payment.",
    "",
    `Bill: ${billLabel}`,
    `Due Date: ${due}`,
    `Outstanding: ${amount}`,
    "",
    "We kindly request you to complete the payment at your earliest convenience.",
    "",
    "If payment has already been made, please disregard this message.",
    "",
    "Thank you for your continued business.",
    "Jambh Electricals",
  ].join("\n");
}

async function loadSettings(): Promise<ReminderSettings> {
  try {
    const doc = await sanityClient.fetch<Record<string, unknown> | null>(
      `*[_type == "billReminderSettings"][0]`,
    );
    if (!doc) return DEFAULT_SETTINGS;
    return {
      enabled: doc.autoReminderEnabled !== false,
      gapDays: Math.max(1, Math.trunc(Number(doc.billReminderGapDays) || DEFAULT_SETTINGS.gapDays)),
      minimumAmount: Math.max(0, Number(doc.minimumPendingAmountForReminder) || DEFAULT_SETTINGS.minimumAmount),
      sendHour: Math.max(0, Math.min(23, Number(doc.reminderSendHour) || DEFAULT_SETTINGS.sendHour)),
      sendMinute: Math.max(0, Math.min(59, Number(doc.reminderSendMinute) || DEFAULT_SETTINGS.sendMinute)),
      timezone: String(doc.timezone || DEFAULT_SETTINGS.timezone),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function fetchPendingBills(): Promise<BillDoc[]> {
  const bills = await sanityClient.fetch<BillDoc[]>(
    `*[_type == "bill"] | order(dueDate asc) {
      _id, billNumber, status, paymentStatus, totalAmount, paidAmount, balanceAmount,
      dueDate, createdAt, lastReminderSentAt, reminderCount,
      customer->{ _id, name, nickname, phone, allowDueReminder }
    }`,
  );
  return (bills || []).filter(isEligibleBill).filter((b) => b.customer?._id && b.customer?.phone);
}

function isReminderDue(bill: BillDoc, gapDays: number): boolean {
  const baseDate = bill.dueDate || bill.createdAt;
  if (!baseDate) return false;

  const nowKey = indianDateKey();
  const firstEligible = addDays(ymd(new Date(baseDate)), gapDays);
  if (nowKey < firstEligible) return false;

  if (!bill.lastReminderSentAt) return true;

  const lastSentKey = ymd(new Date(bill.lastReminderSentAt));
  const nextEligible = addDays(lastSentKey, gapDays);
  return nowKey >= nextEligible;
}

async function updateBillTracking(billId: string): Promise<void> {
  try {
    const bill = await sanityClient.fetch<{ reminderCount?: number } | null>(
      `*[_type == "bill" && _id == $id]{_id, reminderCount}`,
      { id: billId },
    );
    if (!bill) return;
    await sanityClient
      .patch(billId)
      .set({
        lastReminderSentAt: new Date().toISOString(),
        reminderCount: (bill.reminderCount || 0) + 1,
      })
      .commit();
  } catch (err) {
    console.error("[BillReminder] Failed to update bill tracking:", billId, err);
  }
}

async function createReminderLog(params: {
  billId: string;
  customerId: string;
  status: string;
  reason?: string;
}): Promise<void> {
  const safeId = `${params.billId}:${indianDateKey()}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  try {
    await sanityClient.createIfNotExists({
      _id: `billReminderLog.${safeId}`,
      _type: "billReminderLog",
      idempotencyKey: `chatBackend:${params.billId}:${indianDateKey()}`,
      reminderType: "daily_reminder",
      mode: "auto",
      status: params.status,
      reason: params.reason || "",
      customerId: params.customerId,
      customer: { _type: "reference", _ref: params.customerId },
      billIds: [params.billId],
      dueDate: "",
      cycleDate: indianDateKey(),
      totalPendingAmount: 0,
      billCount: 1,
      adminId: "chat-backend-scheduler",
      payload: { json: JSON.stringify({ sentAt: new Date().toISOString() }) },
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[BillReminder] Failed to create log:", err);
  }
}

export async function loadBillReminderSettings(): Promise<ReminderSettings> {
  return loadSettings();
}

async function processReminders(): Promise<void> {
  if (!isWaConfigured()) {
    console.warn("[BillReminder] WhatsApp bot not configured, skipping");
    return;
  }

  const settings = await loadSettings();
  if (!settings.enabled) {
    console.log("[BillReminder] Reminders disabled in settings");
    return;
  }

  const dateKey = indianDateKey();
  console.log(`[BillReminder] Running for ${dateKey}`);

  const bills = await fetchPendingBills();
  if (!bills.length) {
    console.log("[BillReminder] No pending bills found");
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const bill of bills) {
    const customerId = bill.customer!._id;
    const dedupeKey = `${customerId}:${bill._id}:${dateKey}`;

    if (sentToday.has(dedupeKey)) {
      skipped++;
      continue;
    }

    if (bill.customer!.allowDueReminder === false) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "customer_disabled" });
      continue;
    }

    if (pendingAmount(bill) < settings.minimumAmount) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "below_minimum" });
      continue;
    }

    if (!isReminderDue(bill, settings.gapDays)) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "gap_not_completed" });
      continue;
    }

    const phone = String(bill.customer!.phone || "").trim();
    if (!phone) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "no_phone" });
      continue;
    }

    const message = buildReminderMessage(bill);
    const result = await sendWaText(phone, message);

    if (result.ok) {
      sent++;
      sentToday.add(dedupeKey);
      await updateBillTracking(bill._id);
      await createReminderLog({ billId: bill._id, customerId, status: "sent" });
      console.log(`[BillReminder] Sent to ${customerId} (${bill.billNumber || bill._id})`);
    } else {
      failed++;
      await createReminderLog({ billId: bill._id, customerId, status: "failed", reason: result.error });
      console.warn(`[BillReminder] Failed for ${customerId}: ${result.error}`);
    }
  }

  console.log(`[BillReminder] Done: sent=${sent}, skipped=${skipped}, failed=${failed}`);
}

function tick() {
  const { hour, minute } = localTimeParts();
  const { sendHour, sendMinute } = localSettings;

  if (hour !== sendHour || minute !== sendMinute) return;

  const dateKey = indianDateKey();
  const runKey = `billReminder:${dateKey}`;
  if (sentToday.has(runKey)) return;
  sentToday.add(runKey);

  console.log(`[BillReminder] Triggered at ${hour}:${String(minute).padStart(2, "0")}`);
  processReminders().catch((err) => {
    console.error("[BillReminder] Processing error:", err);
  });
}

let localSettings: ReminderSettings = DEFAULT_SETTINGS;

export async function triggerBillReminders(): Promise<{ sent: number; skipped: number; failed: number }> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { sent: 0, skipped: 0, failed: 0 };
  }

  if (!isWaConfigured()) {
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const bills = await fetchPendingBills();
  if (!bills.length) {
    return { sent: 0, skipped: 0, failed: 0 };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const dateKey = indianDateKey();

  for (const bill of bills) {
    const customerId = bill.customer!._id;
    const dedupeKey = `${customerId}:${bill._id}:${dateKey}`;

    if (sentToday.has(dedupeKey)) {
      skipped++;
      continue;
    }

    if (bill.customer!.allowDueReminder === false) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "customer_disabled" });
      continue;
    }

    if (pendingAmount(bill) < settings.minimumAmount) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "below_minimum" });
      continue;
    }

    if (!isReminderDue(bill, settings.gapDays)) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "gap_not_completed" });
      continue;
    }

    const phone = String(bill.customer!.phone || "").trim();
    if (!phone) {
      skipped++;
      await createReminderLog({ billId: bill._id, customerId, status: "skipped", reason: "no_phone" });
      continue;
    }

    const message = buildReminderMessage(bill);
    const result = await sendWaText(phone, message);

    if (result.ok) {
      sent++;
      sentToday.add(dedupeKey);
      await updateBillTracking(bill._id);
      await createReminderLog({ billId: bill._id, customerId, status: "sent" });
    } else {
      failed++;
      await createReminderLog({ billId: bill._id, customerId, status: "failed", reason: result.error });
    }
  }

  return { sent, skipped, failed };
}

export async function startBillReminderScheduler(): Promise<void> {
  if (schedulerStarted) return;
  if (!env.sanityProjectId) {
    console.warn("[BillReminder] Skipping: SANITY_PROJECT_ID not set");
    return;
  }

  localSettings = await loadSettings();
  schedulerStarted = true;

  void tick();
  timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();

  console.log("[BillReminder] Scheduler started", {
    sendHour: localSettings.sendHour,
    sendMinute: localSettings.sendMinute,
    gapDays: localSettings.gapDays,
    minimumAmount: localSettings.minimumAmount,
  });
}

export function stopBillReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  schedulerStarted = false;
}
