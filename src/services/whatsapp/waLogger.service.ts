type WaLogLevel = "info" | "warn" | "error";

export type WaLogEntry = {
  at: string;
  level: WaLogLevel;
  step: string;
  eventType?: string;
  idempotencyKey?: string;
  eventId?: string;
  recipient?: string;
  details?: Record<string, unknown>;
};

const MAX_LOGS = 500;

class WaLoggerService {
  private logs: WaLogEntry[] = [];

  log(level: WaLogLevel, step: string, entry: Omit<WaLogEntry, "at" | "level" | "step"> = {}) {
    const logEntry: WaLogEntry = { at: new Date().toISOString(), level, step, ...entry };
    this.logs.push(logEntry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    method("[wa]", step, JSON.stringify(entry));
  }

  eventReceived(eventType: string, eventId: string, idempotencyKey: string) {
    this.log("info", "event received", { eventType, eventId, idempotencyKey });
  }

  payloadValidated(eventType: string, idempotencyKey: string) {
    this.log("info", "payload validated", { eventType, idempotencyKey });
  }

  phoneNormalized(phone: string, jid: string, idempotencyKey?: string) {
    this.log("info", "phone normalized", { idempotencyKey, recipient: jid, details: { phone } });
  }

  messageGenerated(eventType: string, idempotencyKey: string) {
    this.log("info", "message generated", { eventType, idempotencyKey });
  }

  botConnected(details: Record<string, unknown> = {}) {
    this.log("info", "bot connected", { details });
  }

  botDisconnected(details: Record<string, unknown> = {}) {
    this.log("warn", "bot disconnected", { details });
  }

  messageQueued(idempotencyKey: string, recipient: string, details: Record<string, unknown> = {}) {
    this.log("info", "message queued", { idempotencyKey, recipient, details });
  }

  messageSent(idempotencyKey: string, recipient: string, details: Record<string, unknown> = {}) {
    this.log("info", "message sent", { idempotencyKey, recipient, details });
  }

  messageFailed(idempotencyKey: string, recipient: string, error: unknown) {
    this.log("error", "message failed", { idempotencyKey, recipient, details: { error: error instanceof Error ? error.message : String(error) } });
  }

  retryScheduled(idempotencyKey: string, recipient: string, attempt: number, delayMs: number, error: unknown) {
    this.log("warn", "retry scheduled", { idempotencyKey, recipient, details: { attempt, delayMs, error: error instanceof Error ? error.message : String(error) } });
  }

  duplicateSkipped(eventType: string, idempotencyKey: string) {
    this.log("info", "duplicate event skipped", { eventType, idempotencyKey });
  }

  getRecentLogs(limit = 100) {
    return this.logs.slice(-Math.max(1, Math.min(500, limit)));
  }
}

export const waLogger = new WaLoggerService();
