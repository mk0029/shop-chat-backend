import { env } from "../config/env";

let started = false;
let timer: NodeJS.Timeout | null = null;
let pingCount = 0;

const DEFAULT_INTERVAL_MS = 50 * 1000;

async function ping() {
  pingCount++;
  const { openwaUrl, openwaApiKey } = env;
  if (!openwaUrl) return;

  try {
    const res = await fetch(`${openwaUrl.replace(/\/+$/, "")}/api/sessions/keep-alive`, {
      method: "GET",
      headers: {
        "x-api-key": openwaApiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      const total = json?.total ?? 0;
      const alive = json?.alive ?? 0;
      if (pingCount % 6 === 0) {
        console.log(`[bot-keepalive] ok (ping #${pingCount}, sessions: ${alive}/${total} alive)`);
      }
    } else {
      console.warn(`[bot-keepalive] unexpected status ${res.status} (ping #${pingCount})`);
    }
  } catch (err) {
    console.warn(`[bot-keepalive] ping #${pingCount} failed:`, err instanceof Error ? err.message : err);
  }
}

export function startBotKeepAlive() {
  if (started || !env.enableBotKeepAlive) return;
  if (!env.openwaUrl) {
    console.warn("[bot-keepalive] skipped: OPENWA_URL not set");
    return;
  }

  started = true;
  const intervalMs = Number(process.env.BOT_KEEPALIVE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  void ping();
  timer = setInterval(() => void ping(), intervalMs);
  timer.unref?.();
  console.log(`[bot-keepalive] started (interval: ${intervalMs}ms, target: ${env.openwaUrl})`);
}

export function stopBotKeepAlive() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
