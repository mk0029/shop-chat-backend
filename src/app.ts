import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env";
import chatRoutes from "./routes/chatRoutes";
import sessionRoutes from "./routes/sessionRoutes";
import notificationRoutes from "./routes/notificationRoutes";
import { createClient } from "@supabase/supabase-js";
import { waf } from "./middleware/security/waf";
import {
  authLimiter,
  searchLimiter,
  uploadLimiter,
  waEventLimiter,
  chatLimiter,
} from "./middleware/security/rateLimiter";

const app = express();
app.set("trust proxy", 1);

const allowedOrigins = new Set(
  [env.shopFrontendUrl, "http://localhost:3000", "http://127.0.0.1:3000","https://jambh-ell.vercel.app"]
    .filter(Boolean)
    .map((origin) => String(origin).replace(/\/+$/, "")),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/+$/, "");
      if (allowedOrigins.has(normalized)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Shop-Auth", "x-user-id", "x-notify-secret", "x-api-key"],
  }),
);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "1mb" }));

app.use(waf);

app.use(
  "/chat",
  chatLimiter,
  chatRoutes,
);

app.use("/internal", sessionRoutes);

app.use(
  "/notifications",
  waEventLimiter,
  notificationRoutes,
);

app.use(
  "/",
  waEventLimiter,
  notificationRoutes,
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "shop-chat-backend", at: new Date().toISOString() });
});

app.get("/ping", async (_req, res) => {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    return res.json({ ok: false, error: "Supabase not configured" });
  }
  try {
    const admin = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const start = Date.now();
    const { error } = await admin.rpc("ping");
    const ms = Date.now() - start;
    if (error) {
      return res.json({ ok: false, error: error.message, ms });
    }
    res.json({ ok: true, ms, at: new Date().toISOString() });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : "unknown", at: new Date().toISOString() });
  }
});

app.get("/health/storage", async (_req, res) => {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    return res.json({ ok: false, error: "Supabase not configured" });
  }
  try {
    const admin = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const start = Date.now();
    const { data: buckets, error: listError } = await admin.storage.listBuckets();
    if (listError) {
      return res.json({ ok: false, error: listError.message, ms: Date.now() - start });
    }
    const requiredBuckets = ["chat-media", "profile-images"];
    const found: string[] = [];
    const missing: string[] = [];
    for (const name of requiredBuckets) {
      if (buckets?.some((b) => b.name === name)) {
        found.push(name);
      } else {
        missing.push(name);
      }
    }
    let storageAccessible = false;
    try {
      const { data: files } = await admin.storage.from("chat-media").list("", { limit: 1 });
      storageAccessible = !files?.length || files.length >= 0;
    } catch {}
    res.json({
      ok: missing.length === 0 && storageAccessible,
      buckets: { found, missing, total: buckets?.length || 0 },
      storage: { accessible: storageAccessible },
      ms: Date.now() - start,
      at: new Date().toISOString(),
    });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : "unknown", at: new Date().toISOString() });
  }
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error?.name === "ZodError") {
    return res.status(400).json({ message: "Validation failed", issues: error.issues });
  }
  console.error(JSON.stringify({
    level: "error",
    event: "unhandled_error",
    timestamp: new Date().toISOString(),
    message: error?.message || String(error),
    stack: error?.stack?.slice(0, 500),
  }));
  res.status(500).json({ message: "Internal server error" });
});

export default app;




