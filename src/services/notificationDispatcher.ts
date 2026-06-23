import { getNotificationQueue, type NotificationJob } from "./notificationQueue";
import { createAndDispatchNotification, type NotificationInput } from "./notificationCenter";
import { notificationLogger } from "../lib/notificationLogger";

const DISPATCHER_HANDLER = "notification_dispatch";

let dispatcherInitialized = false;

function initDispatcher() {
  if (dispatcherInitialized) return;
  dispatcherInitialized = true;

  const queue = getNotificationQueue();
  queue.registerHandler(DISPATCHER_HANDLER, handleNotificationJob);
}

async function handleNotificationJob(job: NotificationJob): Promise<void> {
  const input = job.payload as NotificationInput;
  const startTime = Date.now();

  try {
    notificationLogger.notificationProcessing(
      job.eventId,
      job.eventType,
      job.receiverUserId || "unknown",
    );

    await createAndDispatchNotification(input);

    const durationMs = Date.now() - startTime;
    notificationLogger.notificationSent(
      job.eventId,
      job.receiverUserId || "unknown",
      job.dedupeKey,
      durationMs,
    );
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    notificationLogger.notificationFailed(
      job.eventId,
      job.receiverUserId || "unknown",
      errorMsg,
      job.retryCount,
      job.maxRetries,
    );

    throw error;
  }
}

export function dispatchNotificationAsync(input: NotificationInput) {
  initDispatcher();

  const queue = getNotificationQueue();

  const eventType = String(input.eventType || input.type || "system.general");
  const eventId = input.eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const receiverUserId = input.userId || (input.userIds && input.userIds[0]) || "unknown";

  notificationLogger.eventCreated(eventId, eventType, {
    receiverUserId,
    audience: input.audience,
    hasUserIds: !!input.userIds?.length,
  });

  queue.enqueue({
    eventId,
    eventType,
    dedupeKey: input.data?.dedupeKey as string | undefined,
    receiverUserId,
    payload: input,
    handler: DISPATCHER_HANDLER,
    maxRetries: 3,
    timeoutMs: 20_000,
  });
}

export function dispatchNotificationBackground(input: NotificationInput) {
  dispatchNotificationAsync(input);
}

export function getNotificationQueueStats() {
  return getNotificationQueue().getStats();
}
