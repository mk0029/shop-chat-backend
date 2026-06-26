import { ChatSyncEvent } from "../models/ChatSyncEvent";

type SyncEventType = "message.created" | "message.updated" | "message.deleted" | "room.updated" | "status.updated";

export async function emitSyncEvent(params: {
  eventType: SyncEventType;
  roomId: string;
  payload: Record<string, unknown>;
  userIds?: string[];
}) {
  try {
    await ChatSyncEvent.create({
      eventType: params.eventType,
      roomId: params.roomId,
      payload: params.payload,
      userIds: params.userIds || [],
      createdAt: new Date(),
    });
  } catch {
    // Silently fail - sync events are non-critical
  }
}

export async function getSyncEventsSince(since: Date, userId: string, limit = 100) {
  return ChatSyncEvent.find({
    createdAt: { $gt: since },
    $or: [{ userIds: userId }, { userIds: { $size: 0 } }],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean()
    .then((events) =>
      events.map((event) => ({
        eventId: String(event._id),
        eventType: event.eventType,
        roomId: String(event.roomId),
        payload: event.payload,
        createdAt: (event as any).createdAt?.toISOString?.() || event.createdAt,
      })),
    );
}
