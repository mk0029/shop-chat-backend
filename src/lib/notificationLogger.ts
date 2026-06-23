export type LogLevel = "info" | "warn" | "error" | "debug";

export type NotificationLogEntry = {
  timestamp: string;
  level: LogLevel;
  category: "event_created" | "notification_queued" | "notification_processing" | "fcm_sent" | "fcm_failed" | "notification_sent" | "notification_failed" | "notification_skipped" | "notification_retry" | "queue_stats" | "socket_emitted" | "socket_failed";
  eventId?: string;
  eventType?: string;
  receiverUserId?: string;
  dedupeKey?: string;
  retryCount?: number;
  maxRetries?: number;
  durationMs?: number;
  error?: string;
  meta?: Record<string, any>;
};

const LOG_BUFFER: NotificationLogEntry[] = [];
const MAX_BUFFER_SIZE = 500;
let flushTimer: NodeJS.Timeout | null = null;

function append(entry: NotificationLogEntry) {
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length > MAX_BUFFER_SIZE) {
    LOG_BUFFER.splice(0, LOG_BUFFER.length - MAX_BUFFER_SIZE);
  }
}

function formatEntry(entry: NotificationLogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level.toUpperCase()}]`,
    `[${entry.category}]`,
  ];
  if (entry.eventId) parts.push(`event=${entry.eventId}`);
  if (entry.eventType) parts.push(`type=${entry.eventType}`);
  if (entry.receiverUserId) parts.push(`to=${entry.receiverUserId}`);
  if (entry.dedupeKey) parts.push(`dedup=${entry.dedupeKey}`);
  if (entry.retryCount !== undefined) parts.push(`retry=${entry.retryCount}/${entry.maxRetries}`);
  if (entry.durationMs !== undefined) parts.push(`${entry.durationMs}ms`);
  if (entry.error) parts.push(`err="${entry.error}"`);
  if (entry.meta && Object.keys(entry.meta).length > 0) parts.push(JSON.stringify(entry.meta));
  return parts.join(" ");
}

export const notificationLogger = {
  eventCreated(eventId: string, eventType: string, meta?: Record<string, any>) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      category: "event_created",
      eventId,
      eventType,
      meta,
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  notificationQueued(eventId: string, eventType: string, dedupeKey?: string, meta?: Record<string, any>) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      category: "notification_queued",
      eventId,
      eventType,
      dedupeKey,
      meta,
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  notificationProcessing(eventId: string, eventType: string, receiverUserId: string) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "debug",
      category: "notification_processing",
      eventId,
      eventType,
      receiverUserId,
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  fcmSent(eventId: string, receiverUserId: string, dedupeKey?: string, durationMs?: number, meta?: Record<string, any>) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      category: "fcm_sent",
      eventId,
      receiverUserId,
      dedupeKey,
      durationMs,
      meta,
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  fcmFailed(eventId: string, receiverUserId: string, error: string, dedupeKey?: string, retryCount?: number, maxRetries?: number) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      category: "fcm_failed",
      eventId,
      receiverUserId,
      dedupeKey,
      retryCount,
      maxRetries,
      error,
    };
    append(entry);
    console.warn(formatEntry(entry));
  },

  notificationSent(eventId: string, receiverUserId: string, dedupeKey?: string, durationMs?: number) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      category: "notification_sent",
      eventId,
      receiverUserId,
      dedupeKey,
      durationMs,
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  notificationFailed(eventId: string, receiverUserId: string, error: string, retryCount?: number, maxRetries?: number) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      category: "notification_failed",
      eventId,
      receiverUserId,
      retryCount,
      maxRetries,
      error,
    };
    append(entry);
    console.error(formatEntry(entry));
  },

  notificationSkipped(eventId: string, receiverUserId: string, reason: string, dedupeKey?: string) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      category: "notification_skipped",
      eventId,
      receiverUserId,
      dedupeKey,
      meta: { reason },
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  notificationRetry(eventId: string, receiverUserId: string, retryCount: number, maxRetries: number, error: string) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      category: "notification_retry",
      eventId,
      receiverUserId,
      retryCount,
      maxRetries,
      error,
    };
    append(entry);
    console.warn(formatEntry(entry));
  },

  queueStats(stats: { pending: number; processing: number; completed: number; failed: number; totalEnqueued: number }) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      category: "queue_stats",
      meta: stats,
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  socketEmitted(eventId: string, eventType: string, meta?: Record<string, any>) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "debug",
      category: "socket_emitted",
      eventId,
      eventType,
      meta,
    };
    append(entry);
    console.log(formatEntry(entry));
  },

  socketFailed(eventId: string, eventType: string, error: string) {
    const entry: NotificationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      category: "socket_failed",
      eventId,
      eventType,
      error,
    };
    append(entry);
    console.warn(formatEntry(entry));
  },

  getRecentLogs(count = 100): NotificationLogEntry[] {
    return LOG_BUFFER.slice(-count);
  },

  startPeriodicFlush(intervalMs = 60_000) {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      if (LOG_BUFFER.length > 0) {
        console.log(`[notification-logger] buffer flush: ${LOG_BUFFER.length} entries`);
      }
    }, intervalMs);
    flushTimer.unref?.();
  },

  stopPeriodicFlush() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  },
};
