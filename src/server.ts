import http from "http";
import { Server } from "socket.io";
import app from "./app";
import { connectDb } from "./config/db";
import { env, validateEnv } from "./config/env";
import { registerChatSocket } from "./sockets/chatSocket";
import { startNotificationScheduler } from "./services/notificationScheduler";
import { startNotificationQueue, stopNotificationQueue } from "./services/notificationQueue";
import { notificationLogger } from "./lib/notificationLogger";
import { waClient } from "./services/whatsapp/waClient.service";
import { waQueue } from "./services/whatsapp/waQueue.service";

async function main() {
  validateEnv();
  await connectDb();

  startNotificationQueue({ concurrency: 5, defaultMaxRetries: 3, defaultTimeoutMs: 20_000 });
  notificationLogger.startPeriodicFlush();
  waQueue.start();
  void waClient.start("server_startup");

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

  server.listen(env.port, () => {
    console.log(`[shop-chat] listening on ${env.port}`);
  });

  const shutdown = () => {
    console.log("[shop-chat] shutting down...");
    stopNotificationQueue();
    notificationLogger.stopPeriodicFlush();
    waQueue.stop();
    void waClient.shutdown();
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


