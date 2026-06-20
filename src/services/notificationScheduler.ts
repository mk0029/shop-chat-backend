import { env } from "../config/env";
import { createAndDispatchNotification } from "./notificationCenter";

let schedulerStarted = false;
let timer: NodeJS.Timeout | null = null;
const sentInProcess = new Set<string>();

function indianDateKey(date = new Date()) {
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
    hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value || 0),
  };
}

function greetingWindowMinutes() {
  const start = env.notificationGreetingHour * 60 + env.notificationGreetingMinute;
  const configuredEnd = env.notificationGreetingEndHour * 60 + env.notificationGreetingEndMinute;
  const fallbackEnd = start + env.notificationGreetingWindowMinutes;
  const end = configuredEnd > start ? configuredEnd : fallbackEnd;
  return { start, end };
}

async function sendOnce(key: string, input: Parameters<typeof createAndDispatchNotification>[0]) {
  if (sentInProcess.has(key)) {
    console.log("[notifications] scheduler skipped in-process duplicate", { key });
    return;
  }
  sentInProcess.add(key);
  console.log("[notifications] scheduler dispatch", { key, eventType: input.eventType || input.type, eventId: input.eventId });
  await createAndDispatchNotification(input).catch((error) => {
    sentInProcess.delete(key);
    console.warn("[notifications] scheduled send failed", error instanceof Error ? error.message : error);
  });
}

async function tick() {
  const dateKey = indianDateKey();
  const { hour, minute } = localTimeParts();
  const nowMinutes = hour * 60 + minute;
  const { start: greetingMinutes, end: greetingEndMinutes } = greetingWindowMinutes();
  const isGreetingDue = nowMinutes >= greetingMinutes && nowMinutes < greetingEndMinutes;
  if (!isGreetingDue) return;

  const greetingKey = `daily_good_morning:${dateKey}`;
  if (sentInProcess.has(greetingKey)) return;

  console.log("[notifications] scheduler tick", {
    dateKey,
    nowMinutes,
    greetingMinutes,
    greetingEndMinutes,
    isGreetingDue,
  });

  await sendOnce(greetingKey, {
    eventType: "daily_good_morning",
    eventId: `daily_good_morning.${dateKey}`,
    actorUserId: "system",
    data: { route: "/", greetingDate: dateKey },
  });
}

export function startNotificationScheduler() {
  if (schedulerStarted || !env.enableNotificationCron) return;
  schedulerStarted = true;
  const { start, end } = greetingWindowMinutes();
  void tick();
  timer = setInterval(() => void tick(), 60 * 1000);
  timer.unref?.();
  console.log("[notifications] scheduler started", {
    timezone: env.notificationGreetingTimezone,
    hour: env.notificationGreetingHour,
    minute: env.notificationGreetingMinute,
    startMinutes: start,
    endMinutes: end,
    dailyGoodMorning: true,
    festivalGreetings: false,
  });
}
