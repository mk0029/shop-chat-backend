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
