import { env } from "../config/env";
import { processNotificationEvent } from "./notificationCenter";

let schedulerStarted = false;
let timer: NodeJS.Timeout | null = null;
const sentInProcess = new Set<string>();
const festivalCache = new Map<string, { expiresAt: number; festivalsByDate: Map<string, string[]> }>();
const HINDU_FESTIVAL_PATTERNS = [
  /diwali/i,
  /deepavali/i,
  /holi/i,
  /dussehra/i,
  /vijaya\s*dashami/i,
  /janmashtami/i,
  /shivaratri/i,
  /ram\s*navami/i,
  /ganesh\s*chaturthi/i,
  /makar\s*sankranti/i,
  /raksha\s*bandhan/i,
  /navratri/i,
  /durga\s*puja/i,
  /govardhan/i,
  /bhai\s*duj/i,
  /hanuman\s*jayanti/i,
  /akshaya\s*tritiya/i,
  /karwa\s*chauth/i,
  /onam/i,
  /pongal/i,
];

function indianDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function indianHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(date),
  );
}

function yearFromDateKey(dateKey: string) {
  return dateKey.slice(0, 4);
}

function normalizeHolidayDate(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value === "object") {
    const input = value as { iso?: unknown; datetime?: { year?: unknown; month?: unknown; day?: unknown } };
    if (typeof input.iso === "string") return input.iso.slice(0, 10);
    const year = Number(input.datetime?.year);
    const month = Number(input.datetime?.month);
    const day = Number(input.datetime?.day);
    if (year && month && day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return "";
}

function extractHolidayItems(payload: any): Array<{ name: string; date: string }> {
  const candidates =
    payload?.response?.holidays ||
    payload?.holidays ||
    payload?.items ||
    payload?.data ||
    payload;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((item) => ({
      name: String(item?.name || item?.title || item?.summary || "").trim(),
      date: normalizeHolidayDate(item?.date || item?.start?.date || item?.start),
    }))
    .filter((item) => item.name && item.date);
}

function isHinduFestival(name: string) {
  return HINDU_FESTIVAL_PATTERNS.some((pattern) => pattern.test(name));
}

function calendarUrlForYear(year: string) {
  if (env.holidayCalendarApiUrl) {
    return env.holidayCalendarApiUrl
      .replace(/\{year\}/g, encodeURIComponent(year))
      .replace(/\{country\}/g, encodeURIComponent(env.holidayCalendarCountry));
  }
  if (!env.holidayCalendarApiKey) return "";
  const url = new URL("https://calendarific.com/api/v2/holidays");
  url.searchParams.set("api_key", env.holidayCalendarApiKey);
  url.searchParams.set("country", env.holidayCalendarCountry);
  url.searchParams.set("year", year);
  url.searchParams.set("type", "national,religious");
  return url.toString();
}

async function loadFestivalCalendar(year: string) {
  const cached = festivalCache.get(year);
  if (cached && cached.expiresAt > Date.now()) return cached.festivalsByDate;

  const festivalsByDate = new Map<string, string[]>();
  const url = calendarUrlForYear(year);
  if (!url) {
    console.warn("[notifications] holiday calendar API not configured; festival greetings disabled");
    festivalCache.set(year, { expiresAt: Date.now() + 60 * 60_000, festivalsByDate });
    return festivalsByDate;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`calendar API HTTP ${response.status}`);
    const payload = await response.json();
    for (const holiday of extractHolidayItems(payload)) {
      if (!isHinduFestival(holiday.name)) continue;
      const list = festivalsByDate.get(holiday.date) || [];
      if (!list.includes(holiday.name)) list.push(holiday.name);
      festivalsByDate.set(holiday.date, list);
    }
    festivalCache.set(year, { expiresAt: Date.now() + 12 * 60 * 60_000, festivalsByDate });
  } catch (error) {
    console.warn("[notifications] holiday calendar API failed", error instanceof Error ? error.message : error);
    festivalCache.set(year, { expiresAt: Date.now() + 60 * 60_000, festivalsByDate });
  }
  return festivalsByDate;
}

async function festivalFor(dateKey: string) {
  const festivalsByDate = await loadFestivalCalendar(yearFromDateKey(dateKey));
  return (festivalsByDate.get(dateKey) || []).join(" / ");
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
  const hour = indianHour();
  if (hour === 8) {
    await sendOnce(`daily_good_morning:${dateKey}`, {
      eventType: "daily_good_morning",
      eventId: `daily_good_morning.${dateKey}`,
      actorUserId: "system",
      title: "Good morning",
      body: "Good morning from Jambh Electrics.",
      data: { route: "/", greetingDate: dateKey },
    });
  }

  const festival = await festivalFor(dateKey);
  if (festival && hour === 8) {
    await sendOnce(`hindu_festival_greeting:${dateKey}`, {
      eventType: "hindu_festival_greeting",
      eventId: `hindu_festival_greeting.${dateKey}`,
      actorUserId: "system",
      title: festival,
      body: `Wishing you a happy ${festival}.`,
      data: { route: "/", festivalDate: dateKey, festivalName: festival },
    });
  }
}

export function startNotificationScheduler() {
  if (schedulerStarted || !env.enableNotificationCron) return;
  schedulerStarted = true;
  void tick();
  timer = setInterval(() => void tick(), 30 * 60 * 1000);
  timer.unref?.();
  console.log("[notifications] scheduler started");
}
