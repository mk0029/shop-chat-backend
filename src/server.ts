import http from "http";
import { Server } from "socket.io";
import app from "./app";
import { connectDb } from "./config/db";
import { env, validateEnv } from "./config/env";
import { registerChatSocket } from "./sockets/chatSocket";

async function main() {
  validateEnv();
  await connectDb();

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: [env.shopFrontendUrl, "http://localhost:3000", "http://127.0.0.1:3000"],
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  registerChatSocket(io);

  server.listen(env.port, () => {
    console.log(`[shop-chat] listening on ${env.port}`);
  });
}

main().catch((error) => {
  console.error("[shop-chat] failed to start", error);
  process.exit(1);
});
