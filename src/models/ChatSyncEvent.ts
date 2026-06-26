import mongoose, { Schema, type InferSchemaType } from "mongoose";

const ChatSyncEventSchema = new Schema(
  {
    eventType: {
      type: String,
      enum: ["message.created", "message.updated", "message.deleted", "room.updated", "status.updated"],
      required: true,
      index: true,
    },
    roomId: { type: Schema.Types.ObjectId, ref: "ShopChatRoom", required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    userIds: { type: [String], default: [], index: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

ChatSyncEventSchema.index({ createdAt: -1 });
ChatSyncEventSchema.index({ roomId: 1, createdAt: -1 });
ChatSyncEventSchema.index({ userIds: 1, createdAt: -1 });

export type ChatSyncEventDoc = InferSchemaType<typeof ChatSyncEventSchema> & { _id: mongoose.Types.ObjectId };
export const ChatSyncEvent = mongoose.model("ChatSyncEvent", ChatSyncEventSchema);
