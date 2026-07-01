import { env } from "../../config/env";
import { WaEventLog } from "../../models/WaEventLog";
import { waClient } from "./waClient.service";
import { waLogger } from "./waLogger.service";

type WaQueueJob = {
  id: string;
  eventType: string;
  eventId: string;
  idempotencyKey: string;
  jid: string;
  text: string;
  attempts: number;
  maxRetries: number;
  status: "pending" | "processing" | "sent" | "failed";
  createdAt: string;
  lastError?: string;
};

class WaQueueService {
  private queue: WaQueueJob[] = [];
  private processing = false;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    setInterval(() => this.processNext(), Math.max(5_000, env.waQueueRetryDelayMs)).unref?.();
  }

  stop() {
    this.started = false;
  }

  enqueue(input: Omit<WaQueueJob, "id" | "attempts" | "maxRetries" | "status" | "createdAt">) {
    const existing = this.queue.find((job) => job.idempotencyKey === input.idempotencyKey && job.jid === input.jid && job.status !== "failed" && job.status !== "sent");
    if (existing) return existing;
    const job: WaQueueJob = {
      ...input,
      id: `wa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      attempts: 0,
      maxRetries: env.waQueueMaxRetries,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.queue.push(job);
    waLogger.messageQueued(job.idempotencyKey, job.jid, { jobId: job.id, queueLength: this.queue.length });
    void WaEventLog.updateOne({ idempotencyKey: job.idempotencyKey }, { $set: { status: "queued", recipientJids: [job.jid] } }).catch(() => {});
    this.processNext();
    return job;
  }

  private processNext() {
    if (!this.started || this.processing) return;
    const job = this.queue.find((item) => item.status === "pending");
    if (!job) return;
    this.processing = true;
    job.status = "processing";
    job.attempts += 1;
    waClient.sendText({ jid: job.jid, text: job.text, idempotencyKey: job.idempotencyKey })
      .then(async (result) => {
        job.status = "sent";
        waLogger.messageSent(job.idempotencyKey, job.jid, { messageId: result.messageId, attempts: job.attempts });
        await WaEventLog.updateOne(
          { idempotencyKey: job.idempotencyKey },
          { $set: { status: "sent", sentAt: new Date(), recipientJids: [job.jid], messageIds: [result.messageId].filter(Boolean), attempts: job.attempts, failureReason: "" } },
        );
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        job.lastError = message;
        waLogger.messageFailed(job.idempotencyKey, job.jid, error);
        await WaEventLog.updateOne({ idempotencyKey: job.idempotencyKey }, { $set: { status: "failed", failureReason: message, attempts: job.attempts } });
        if (job.attempts < job.maxRetries) {
          job.status = "pending";
          const delayMs = env.waQueueRetryDelayMs * Math.pow(1.5, job.attempts - 1);
          waLogger.retryScheduled(job.idempotencyKey, job.jid, job.attempts + 1, delayMs, error);
          setTimeout(() => this.processNext(), delayMs).unref?.();
        } else {
          job.status = "failed";
        }
      })
      .finally(() => {
        this.processing = false;
        this.queue = this.queue.filter((item) => item.status !== "sent");
        this.processNext();
      });
  }

  getStats() {
    return {
      pending: this.queue.filter((job) => job.status === "pending").length,
      processing: this.queue.filter((job) => job.status === "processing").length,
      failed: this.queue.filter((job) => job.status === "failed").length,
      total: this.queue.length,
    };
  }
}

export const waQueue = new WaQueueService();
