import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, type WASocket } from "@whiskeysockets/baileys";
import fs from "fs/promises";
import pino from "pino";
import { env } from "../../config/env";
import { waLogger } from "./waLogger.service";

export type WaClientState = "disconnected" | "starting" | "qr_required" | "ready" | "reconnecting" | "conflict" | "auth_error" | "error";

type SendTextInput = { jid: string; text: string; idempotencyKey: string };

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeStatusCode(lastDisconnect: any) {
  const error = lastDisconnect?.error;
  return error?.output?.statusCode || error?.status || error?.code || null;
}

function closeMessage(lastDisconnect: any) {
  const error = lastDisconnect?.error;
  return error?.message || error?.description || "";
}

function isConflict(statusCode: any, message: string) {
  const text = String(message || "").toLowerCase();
  return statusCode === 440 || text.includes("conflict") || text.includes("replaced");
}

class WaClientService {
  private socket: WASocket | null = null;
  private state: WaClientState = "disconnected";
  private startPromise: Promise<boolean> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private reconnectAttempts = 0;
  private qr: string | null = null;
  private lastError = "";
  private lastConnectedAt: string | null = null;
  private sendChain = Promise.resolve();

  getStatus() {
    return {
      state: this.state,
      ready: this.isReady(),
      hasQr: Boolean(this.qr),
      qr: this.qr,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      reconnectAttempts: this.reconnectAttempts,
      generation: this.generation,
      jid: this.socket?.user?.id || null,
      authDir: env.waAuthDir,
    };
  }

  isReady() {
    return this.state === "ready" && Boolean(this.socket?.user?.id);
  }

  async start(reason = "startup") {
    if (this.isReady()) return true;
    if (this.state === "conflict" || this.state === "auth_error") return false;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(reason).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(reason: string) {
    this.state = this.state === "reconnecting" ? "reconnecting" : "starting";
    this.generation += 1;
    const generation = this.generation;
    await this.stopSocket(false);
    await fs.mkdir(env.waAuthDir, { recursive: true });
    try {
      const auth = await useMultiFileAuthState(env.waAuthDir);
      const { version } = await fetchLatestBaileysVersion();
      const socket = makeWASocket({
        version,
        auth: auth.state,
        browser: Browsers.ubuntu("Shop Backend WA Bot"),
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });
      this.socket = socket;
      socket.ev.on("creds.update", auth.saveCreds);
      socket.ev.on("connection.update", async (update) => {
        if (generation !== this.generation) return;
        if (update.qr) {
          this.qr = update.qr;
          this.state = "qr_required";
          waLogger.log("info", "bot qr required", { details: { reason } });
        }
        if (update.connection === "open") {
          this.qr = null;
          this.reconnectAttempts = 0;
          this.lastError = "";
          this.lastConnectedAt = new Date().toISOString();
          this.state = "ready";
          waLogger.botConnected({ jid: socket.user?.id, generation });
        }
        if (update.connection === "close") await this.handleClose(update.lastDisconnect, generation);
      });
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "error";
      waLogger.log("error", "bot start failed", { details: { reason, error: this.lastError } });
      this.scheduleReconnect("start_failed");
      return false;
    }
  }

  private async handleClose(lastDisconnect: any, generation: number) {
    const statusCode = closeStatusCode(lastDisconnect);
    const message = closeMessage(lastDisconnect);
    this.socket = null;
    this.lastError = message || String(statusCode || "closed");
    waLogger.botDisconnected({ statusCode, message, generation });

    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
      this.state = "qr_required";
      return;
    }
    if (isConflict(statusCode, message)) {
      this.state = "conflict";
      return;
    }
    this.state = "disconnected";
    this.scheduleReconnect(message || "closed");
  }

  private scheduleReconnect(reason: string) {
    if (this.state === "conflict" || this.state === "auth_error" || this.state === "qr_required") return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const attempt = this.reconnectAttempts + 1;
    this.reconnectAttempts = attempt;
    const delayMs = Math.min(env.waReconnectBaseDelayMs * Math.pow(1.5, attempt - 1), env.waReconnectMaxDelayMs);
    this.state = "reconnecting";
    waLogger.log("info", "bot reconnect scheduled", { details: { reason, attempt, delayMs } });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start("reconnect");
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async stopSocket(updateState = true) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { (socket.ev as any).removeAllListeners(); } catch {}
      try { (socket as any).end(); } catch {}
      try { (socket.ws as any).close(); } catch {}
    }
    if (updateState) this.state = "disconnected";
  }

  async shutdown() {
    await this.stopSocket(true);
  }

  async sendText(input: SendTextInput) {
    const run = this.sendChain.then(async () => {
      if (!this.isReady() || !this.socket) {
        await this.start("send_wake");
      }
      if (!this.isReady() || !this.socket) {
        const error = new Error(`WhatsApp bot is not connected (${this.state})`);
        (error as any).code = "WA_NOT_READY";
        throw error;
      }
      const text = String(input.text || "").trim();
      if (!text) throw new Error("WhatsApp message is empty");
      const result = await Promise.race([
        this.socket.sendMessage(input.jid, { text }),
        wait(env.waSendTimeoutMs).then(() => { throw new Error(`WhatsApp send timeout after ${env.waSendTimeoutMs}ms`); }),
      ]);
      return { jid: input.jid, messageId: (result as any)?.key?.id || null };
    });
    this.sendChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

export const waClient = new WaClientService();



