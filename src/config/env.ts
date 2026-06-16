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
  notificationGreetingHour: Math.max(0, Math.min(23, Number(process.env.NOTIFICATION_GREETING_HOUR || 8))),
  notificationGreetingMinute: Math.max(0, Math.min(59, Number(process.env.NOTIFICATION_GREETING_MINUTE || 0))),
  holidayCalendarApiUrl: process.env.HOLIDAY_CALENDAR_API_URL || "",
  holidayCalendarApiKey: process.env.HOLIDAY_CALENDAR_API_KEY || process.env.CALENDARIFIC_API_KEY || "",
  holidayCalendarCountry: process.env.HOLIDAY_CALENDAR_COUNTRY || "IN",
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
