import { env } from "../config/env";
import { processNotificationEvent } from "./notificationCenter";

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

async function sendOnce(key: string, input: Parameters<typeof processNotificationEvent>[0]) {
  if (sentInProcess.has(key)) return;
  sentInProcess.add(key);
  await processNotificationEvent(input).catch((error) => {
    sentInProcess.delete(key);
    console.warn("[notifications] scheduled send failed", error instanceof Error ? error.message : error);
  });
}

async function tick() {
  const dateKey = indianDateKey();
  const { hour, minute } = localTimeParts();
  const nowMinutes = hour * 60 + minute;
  const greetingMinutes = env.notificationGreetingHour * 60 + env.notificationGreetingMinute;
  const isGreetingDue =
    nowMinutes >= greetingMinutes &&
    nowMinutes < greetingMinutes + env.notificationGreetingWindowMinutes;
  if (!isGreetingDue) return;

  await sendOnce(`daily_good_morning:${dateKey}`, {
    eventType: "daily_good_morning",
    eventId: `daily_good_morning.${dateKey}`,
    actorUserId: "system",
    data: { route: "/", greetingDate: dateKey },
  });
}

export function startNotificationScheduler() {
  if (schedulerStarted || !env.enableNotificationCron) return;
  schedulerStarted = true;
  void tick();
  timer = setInterval(() => void tick(), 60 * 1000);
  timer.unref?.();
  console.log("[notifications] scheduler started", {
    timezone: env.notificationGreetingTimezone,
    hour: env.notificationGreetingHour,
    minute: env.notificationGreetingMinute,
    windowMinutes: env.notificationGreetingWindowMinutes,
    dailyGoodMorning: true,
    festivalGreetings: false,
  });
}
