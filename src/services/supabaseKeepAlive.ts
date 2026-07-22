import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env";

let started = false;
let timer: NodeJS.Timeout | null = null;
let pingCount = 0;

const INTERVAL_MS = 60 * 60 * 1000;

function getAdminClient() {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function ping() {
  pingCount++;
  const admin = getAdminClient();
  if (!admin) return;

  try {
    const { error } = await admin.rpc("ping");
    if (error) {
      console.warn("[supabase-keepalive] ping failed:", error.message);
    } else if (pingCount % 6 === 0) {
      console.log(`[supabase-keepalive] ok (ping #${pingCount})`);
    }
  } catch (err) {
    console.warn("[supabase-keepalive] ping error:", err instanceof Error ? err.message : err);
  }
}

export function startSupabaseKeepAlive() {
  if (started || !env.enableSupabaseKeepAlive) return;
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    console.warn("[supabase-keepalive] skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }
  started = true;
  void ping();
  timer = setInterval(() => void ping(), INTERVAL_MS);
  timer.unref?.();
  console.log("[supabase-keepalive] started (interval: 60min)");
}

export function stopSupabaseKeepAlive() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
