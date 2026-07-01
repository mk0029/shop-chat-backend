import dotenv from "dotenv";

dotenv.config();

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
  waAuthDir: process.env.WA_AUTH_DIR || "C:\\tmp\\shop-chat-wa-auth",
  waEventSecret: process.env.WA_EVENT_SECRET || process.env.CHAT_SYNC_TOKEN || process.env.JWT_SECRET || "",
  waDefaultCountryCode: process.env.WA_DEFAULT_COUNTRY_CODE || "91",
  waAdminPhones: process.env.WA_ADMIN_PHONES || process.env.ADMIN_PHONE || "",
  waReconnectBaseDelayMs: Math.max(1_000, Number(process.env.WA_RECONNECT_BASE_DELAY_MS || 5_000)),
  waReconnectMaxDelayMs: Math.max(5_000, Number(process.env.WA_RECONNECT_MAX_DELAY_MS || 60_000)),
  waQueueRetryDelayMs: Math.max(1_000, Number(process.env.WA_QUEUE_RETRY_DELAY_MS || 10_000)),
  waQueueMaxRetries: Math.max(1, Math.min(25, Number(process.env.WA_QUEUE_MAX_RETRIES || 8))),
  waSendTimeoutMs: Math.max(5_000, Number(process.env.WA_SEND_TIMEOUT_MS || 30_000)),
  waLoginUrl: process.env.WA_LOGIN_URL || process.env.LOGIN_URL || `${process.env.SHOP_FRONTEND_URL || "http://localhost:3000"}/login`,
  waAppName: process.env.WA_APP_NAME || process.env.WEBSITE_NAME || "Jambh Electricals",
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

