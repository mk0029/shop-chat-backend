import dotenv from "dotenv";

dotenv.config();

// ─── Multi-Database Sanity Configuration ───────────────────────
// Supports two conventions:
//
//   NEW (Phase 2): SANITY_DB_<ROLE>_* — role-based, purpose-driven
//   LEGACY:        SANITY_PROJECT_<N>_* — numbered, backward-compatible
//
// Both are merged into a single unified list. If a projectId appears
// in both conventions, the SANITY_DB_<ROLE>_* entry wins.

export interface SanityProjectEnvConfig {
  id: string;
  projectId: string;
  dataset: string;
  token: string;
  apiVersion: string;
  label: string;
  enabled: boolean;
  priority: number;
  role?: string;
  purpose?: string[];
  readable?: boolean;
  writable?: boolean;
}

const KNOWN_ROLES = ["primary", "inventory", "billing", "public", "archive", "analytics", "customers", "documents", "logs", "overflow"];

/**
 * Build the list of Sanity databases from environment variables.
 * Supports both SANITY_DB_<ROLE>_* and SANITY_PROJECT_<N>_* conventions.
 */
function buildSanityProjects(): SanityProjectEnvConfig[] {
  const map = new Map<string, SanityProjectEnvConfig>();

  // ── New convention: SANITY_DB_<ROLE>_* ──
  for (const role of KNOWN_ROLES) {
    const prefix = `SANITY_DB_${role.toUpperCase()}`;
    const projectId = process.env[`${prefix}_PROJECT_ID`];
    if (!projectId) continue;

    const purposeStr = process.env[`${prefix}_PURPOSE`] || "";
    const purposes = purposeStr.split(",").map((s) => s.trim()).filter(Boolean);

    map.set(projectId, {
      id: role,
      projectId,
      dataset: process.env[`${prefix}_DATASET`] || "production",
      token: process.env[`${prefix}_TOKEN`] || "",
      apiVersion: process.env[`${prefix}_API_VERSION`] || "2024-01-01",
      label: process.env[`${prefix}_LABEL`] || role.charAt(0).toUpperCase() + role.slice(1),
      enabled: process.env[`${prefix}_ENABLED`] !== "false",
      priority: Number(process.env[`${prefix}_PRIORITY`]) || getDefaultPriority(role),
      role,
      purpose: purposes.length > 0 ? purposes : [role],
      readable: process.env[`${prefix}_READABLE`] !== "false",
      writable: process.env[`${prefix}_WRITABLE`] !== "false",
    });
  }

  // ── Legacy convention: SANITY_PROJECT_<N>_* ──
  // Project 1 uses legacy env vars
  const p1Id = process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || "";
  const p1Dataset = process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || "production";
  const p1Token = process.env.SANITY_API_TOKEN || "";

  if (p1Id && !map.has(p1Id)) {
    map.set(p1Id, {
      id: "project-1",
      projectId: p1Id,
      dataset: p1Dataset,
      token: p1Token,
      apiVersion: process.env.SANITY_API_VERSION || "2024-01-01",
      label: process.env.SANITY_PROJECT_1_LABEL || "Project 1 — Primary",
      enabled: process.env.SANITY_PROJECT_1_ENABLED !== "false",
      priority: Number(process.env.SANITY_PROJECT_1_PRIORITY) || 1,
      role: "primary",
      purpose: ["general", "read", "users", "brands", "categories", "products"],
      readable: true,
      writable: true,
    });
  }

  // Projects 2+ — numbered env vars
  const maxSlots = 20;
  for (let i = 2; i <= maxSlots; i++) {
    const id = process.env[`SANITY_PROJECT_${i}_ID`];
    if (!id) continue;
    if (map.has(id)) continue; // Already defined via SANITY_DB_<ROLE>_* vars

    map.set(id, {
      id: `project-${i}`,
      projectId: id,
      dataset: process.env[`SANITY_PROJECT_${i}_DATASET`] || "production",
      token: process.env[`SANITY_PROJECT_${i}_TOKEN`] || "",
      apiVersion: process.env[`SANITY_PROJECT_${i}_API_VERSION`] || "2024-01-01",
      label: process.env[`SANITY_PROJECT_${i}_LABEL`] || `Project ${i}`,
      enabled: process.env[`SANITY_PROJECT_${i}_ENABLED`] !== "false",
      priority: Number(process.env[`SANITY_PROJECT_${i}_PRIORITY`]) || i,
      role: "primary",
      purpose: ["general"],
      readable: true,
      writable: true,
    });
  }

  return Array.from(map.values()).sort((a, b) => a.priority - b.priority);
}

function getDefaultPriority(role: string): number {
  switch (role) {
    case "primary": return 1;
    case "inventory": return 2;
    case "billing": return 3;
    case "public": return 4;
    default: return 10;
  }
}

export const sanityProjects = buildSanityProjects();

/**
 * Get a specific Sanity database config by key.
 */
export function getSanityProjectConfig(projectKey: string): SanityProjectEnvConfig | undefined {
  return sanityProjects.find((p) => p.id === projectKey);
}

/**
 * Get all enabled Sanity database configs.
 */
export function getEnabledSanityProjectConfigs(): SanityProjectEnvConfig[] {
  return sanityProjects.filter((p) => p.enabled);
}

/**
 * Get Sanity database configs by role.
 */
export function getSanityConfigsByRole(role: string): SanityProjectEnvConfig[] {
  return sanityProjects.filter((p) => p.enabled && p.role === role);
}

// ─── Legacy env export (backward compatible) ───────────────────

export const env = {
  port: Number(process.env.PORT || 5050),
  mongoUri: process.env.MONGO_URI || "",
  shopFrontendUrl: process.env.SHOP_FRONTEND_URL || "http://localhost:3000",
  notificationApiUrl: process.env.NOTIFICATION_API_URL || process.env.SHOP_FRONTEND_URL || "http://localhost:3000",
  sanityProjectId: process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || "",
  sanityDataset: process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || "production",
  sanityApiVersion: process.env.SANITY_API_VERSION || process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2024-01-01",
  sanityApiToken: process.env.SANITY_API_TOKEN || "",
  chatSyncToken: process.env.CHAT_SYNC_TOKEN || process.env.JWT_SECRET || "",
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "",
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL || "",
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY || "",
  fcmAndroidChannelId: process.env.FCM_ANDROID_CHANNEL_ID || "shop_notifications",
  notificationRetryAttempts: Math.max(1, Math.min(5, Number(process.env.NOTIFICATION_RETRY_ATTEMPTS || 2))),
  enableNotificationCron: process.env.ENABLE_NOTIFICATION_CRON === "true",
  notificationGreetingTimezone: process.env.NOTIFICATION_GREETING_TIMEZONE || "Asia/Kolkata",
  notificationGreetingHour: Math.max(0, Math.min(23, Number(process.env.NOTIFICATION_GREETING_HOUR || 6))),
  notificationGreetingMinute: Math.max(0, Math.min(59, Number(process.env.NOTIFICATION_GREETING_MINUTE || 0))),
  notificationGreetingEndHour: Math.max(0, Math.min(23, Number(process.env.NOTIFICATION_GREETING_END_HOUR || 8))),
  notificationGreetingEndMinute: Math.max(0, Math.min(59, Number(process.env.NOTIFICATION_GREETING_END_MINUTE || 0))),
  notificationGreetingWindowMinutes: Math.max(1, Math.min(240, Number(process.env.NOTIFICATION_GREETING_WINDOW_MINUTES || 120))),
  holidayCalendarApiUrl: process.env.HOLIDAY_CALENDAR_API_URL || "",
  holidayCalendarApiKey: process.env.HOLIDAY_CALENDAR_API_KEY || process.env.CALENDARIFIC_API_KEY || "",
  holidayCalendarCountry: process.env.HOLIDAY_CALENDAR_COUNTRY || "IN",
  supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  enableSupabaseKeepAlive: process.env.ENABLE_SUPABASE_KEEPALIVE === "true",
  openwaUrl: process.env.OPENWA_URL || "",
  openwaApiKey: process.env.OPENWA_API_KEY || "",
  enableBotKeepAlive: process.env.ENABLE_BOT_KEEPALIVE === "true",
  openwaSessionId: process.env.OPENWA_SESSION_ID || "",
  enableBillReminderCron: process.env.ENABLE_BILL_REMINDER_CRON === "true",
};

export function validateEnv() {
  const missing: string[] = [];
  if (!env.mongoUri) missing.push("MONGO_URI");
  if (!env.sanityProjectId) missing.push("SANITY_PROJECT_ID");
  if (!env.sanityDataset) missing.push("SANITY_DATASET");

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
