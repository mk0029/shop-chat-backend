import http from "http";
import { Server } from "socket.io";
import app from "./app";
import { connectDb } from "./config/db";
import { env, validateEnv } from "./config/env";
import { registerChatSocket } from "./sockets/chatSocket";
import { startNotificationScheduler } from "./services/notificationScheduler";
import { startNotificationQueue, stopNotificationQueue } from "./services/notificationQueue";
import { startSupabaseKeepAlive, stopSupabaseKeepAlive } from "./services/supabaseKeepAlive";
import { startBotKeepAlive, stopBotKeepAlive } from "./services/botKeepAlive";
import { startBillReminderScheduler, stopBillReminderScheduler } from "./services/billReminderScheduler";
import { notificationLogger } from "./lib/notificationLogger";

async function main() {
  validateEnv();
  await connectDb();

  startNotificationQueue({ concurrency: 5, defaultMaxRetries: 3, defaultTimeoutMs: 20_000 });
  notificationLogger.startPeriodicFlush();

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: [env.shopFrontendUrl, "http://localhost:3000", "http://127.0.0.1:3000","https://jambh-ell.vercel.app"],
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  registerChatSocket(io);
  startNotificationScheduler();
  startSupabaseKeepAlive();
  startBotKeepAlive();

  if (env.enableBillReminderCron) {
    startBillReminderScheduler();
  }

  server.listen(env.port, () => {
    console.log(`[shop-chat] listening on ${env.port}`);
  });

  const shutdown = () => {
    console.log("[shop-chat] shutting down...");
    stopNotificationQueue();
    stopSupabaseKeepAlive();
    stopBotKeepAlive();
    stopBillReminderScheduler();
    notificationLogger.stopPeriodicFlush();
    io.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[shop-chat] failed to start", error);
  process.exit(1);
});




