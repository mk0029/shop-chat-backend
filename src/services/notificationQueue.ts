import { notificationLogger } from "../lib/notificationLogger";

export type NotificationJobStatus = "pending" | "processing" | "completed" | "failed" | "retry";

export type NotificationJob = {
  id: string;
  eventId: string;
  eventType: string;
  dedupeKey?: string;
  receiverUserId?: string;
  payload: Record<string, any>;
  handler: string;
  status: NotificationJobStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
  error?: string;
  timeoutMs: number;
};

type QueueOptions = {
  concurrency?: number;
  defaultMaxRetries?: number;
  defaultTimeoutMs?: number;
  retryDelayMs?: number;
  maxQueueSize?: number;
  statsIntervalMs?: number;
};

const DEFAULT_OPTIONS: Required<QueueOptions> = {
  concurrency: 5,
  defaultMaxRetries: 3,
  defaultTimeoutMs: 15_000,
  retryDelayMs: 1_000,
  maxQueueSize: 2_000,
  statsIntervalMs: 60_000,
};

type JobHandler = (job: NotificationJob) => Promise<void>;

class NotificationQueue {
  private queue: NotificationJob[] = [];
  private processing = new Set<string>();
  private handlers = new Map<string, JobHandler>();
  private options: Required<QueueOptions>;
  private totalEnqueued = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(options?: QueueOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  registerHandler(name: string, handler: JobHandler) {
    this.handlers.set(name, handler);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.statsTimer = setInterval(() => this.emitStats(), this.options.statsIntervalMs);
    this.statsTimer.unref?.();
    notificationLogger.queueStats(this.getStats());
  }

  stop() {
    this.started = false;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  enqueue(input: {
    eventId: string;
    eventType: string;
    dedupeKey?: string;
    receiverUserId?: string;
    payload: Record<string, any>;
    handler: string;
    maxRetries?: number;
    timeoutMs?: number;
  }): NotificationJob {
    if (this.queue.length >= this.options.maxQueueSize) {
      notificationLogger.notificationFailed(
        input.eventId,
        input.receiverUserId || "unknown",
        `Queue full: ${this.queue.length}/${this.options.maxQueueSize}`,
      );
      return this.createFailedJob(input);
    }

    const existingDedupe = input.dedupeKey
      ? this.queue.find(
          (j) =>
            j.dedupeKey === input.dedupeKey &&
            j.receiverUserId === input.receiverUserId &&
            j.status !== "completed" &&
            j.status !== "failed",
        )
      : null;

    if (existingDedupe) {
      notificationLogger.notificationSkipped(
        input.eventId,
        input.receiverUserId || "unknown",
        "duplicate_in_queue",
        input.dedupeKey,
      );
      return existingDedupe;
    }

    const job: NotificationJob = {
      id: `nq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      eventId: input.eventId,
      eventType: input.eventType,
      dedupeKey: input.dedupeKey,
      receiverUserId: input.receiverUserId,
      payload: input.payload,
      handler: input.handler,
      status: "pending",
      retryCount: 0,
      maxRetries: input.maxRetries ?? this.options.defaultMaxRetries,
      createdAt: new Date().toISOString(),
      timeoutMs: input.timeoutMs ?? this.options.defaultTimeoutMs,
    };

    this.queue.push(job);
    this.totalEnqueued += 1;

    notificationLogger.notificationQueued(job.eventId, job.eventType, job.dedupeKey, {
      jobId: job.id,
      queueLength: this.queue.length,
      receiverUserId: job.receiverUserId,
    });

    this.processNext();
    return job;
  }

  private processNext() {
    if (this.processing.size >= this.options.concurrency) return;

    const nextIndex = this.queue.findIndex(
      (j) => j.status === "pending" && !this.processing.has(j.id),
    );
    if (nextIndex === -1) return;

    const job = this.queue[nextIndex];
    job.status = "processing";
    job.processedAt = new Date().toISOString();
    this.processing.add(job.id);

    this.processJob(job)
      .then(() => {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        this.totalCompleted += 1;
        notificationLogger.notificationSent(
          job.eventId,
          job.receiverUserId || "unknown",
          job.dedupeKey,
          job.processedAt ? Date.now() - new Date(job.processedAt).getTime() : undefined,
        );
      })
      .catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        job.error = errorMsg;

        if (job.retryCount < job.maxRetries) {
          job.retryCount += 1;
          job.status = "pending";
          notificationLogger.notificationRetry(
            job.eventId,
            job.receiverUserId || "unknown",
            job.retryCount,
            job.maxRetries,
            errorMsg,
          );
          const delay = this.options.retryDelayMs * Math.pow(2, job.retryCount - 1);
          setTimeout(() => this.processNext(), delay);
        } else {
          job.status = "failed";
          this.totalFailed += 1;
          notificationLogger.notificationFailed(
            job.eventId,
            job.receiverUserId || "unknown",
            errorMsg,
            job.retryCount,
            job.maxRetries,
          );
        }
      })
      .finally(() => {
        this.processing.delete(job.id);
        this.processNext();
      });
  }

  private async processJob(job: NotificationJob): Promise<void> {
    const handler = this.handlers.get(job.handler);
    if (!handler) {
      throw new Error(`No handler registered for: ${job.handler}`);
    }

    notificationLogger.notificationProcessing(job.eventId, job.eventType, job.receiverUserId || "unknown");

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Job timeout after ${job.timeoutMs}ms`));
      }, job.timeoutMs);

      handler(job)
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private createFailedJob(input: {
    eventId: string;
    eventType: string;
    dedupeKey?: string;
    receiverUserId?: string;
    payload: Record<string, any>;
    handler: string;
  }): NotificationJob {
    return {
      id: `nq_failed_${Date.now()}`,
      eventId: input.eventId,
      eventType: input.eventType,
      dedupeKey: input.dedupeKey,
      receiverUserId: input.receiverUserId,
      payload: input.payload,
      handler: input.handler,
      status: "failed",
      retryCount: 0,
      maxRetries: 0,
      createdAt: new Date().toISOString(),
      error: "Queue full",
      timeoutMs: 0,
    };
  }

  getStats() {
    return {
      pending: this.queue.filter((j) => j.status === "pending").length,
      processing: this.processing.size,
      completed: this.totalCompleted,
      failed: this.totalFailed,
      totalEnqueued: this.totalEnqueued,
    };
  }

  private emitStats() {
    const stats = this.getStats();
    notificationLogger.queueStats(stats);
  }

  getQueueLength() {
    return this.queue.length;
  }

  isProcessing() {
    return this.processing.size > 0;
  }
}

let defaultQueue: NotificationQueue | null = null;

export function getNotificationQueue(options?: QueueOptions): NotificationQueue {
  if (!defaultQueue) {
    defaultQueue = new NotificationQueue(options);
  }
  return defaultQueue;
}

export function startNotificationQueue(options?: QueueOptions) {
  const queue = getNotificationQueue(options);
  queue.start();
  return queue;
}

export function stopNotificationQueue() {
  if (defaultQueue) {
    defaultQueue.stop();
  }
}
