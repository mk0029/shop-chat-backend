import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import chatRoutes from "./routes/chatRoutes";
import sessionRoutes from "./routes/sessionRoutes";
import notificationRoutes from "./routes/notificationRoutes";

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
  }),
);
app.use(helmet());
app.use(express.json({ limit: "25mb" }));

app.use(
  "/chat",
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  chatRoutes,
);

app.use("/internal", sessionRoutes);
app.use("/notifications", notificationRoutes);
app.use("/", notificationRoutes);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "shop-chat-backend", at: new Date().toISOString() });
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error?.name === "ZodError") {
    return res.status(400).json({ message: "Validation failed", issues: error.issues });
  }
  console.error("[error]", error);
  res.status(500).json({ message: "Internal server error" });
});

export default app;




