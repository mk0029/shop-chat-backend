import mongoose, { Schema, type InferSchemaType } from "mongoose";

const ParticipantSchema = new Schema(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ["admin", "super_admin", "technician", "customer"], required: true },
    name: { type: String, required: true },
    email: { type: String, default: null },
    phone: { type: String, default: null },
  },
  { _id: false },
);

const LastMessageSchema = new Schema(
  {
    messageId: String,
    text: String,
    type: { type: String, default: "text" },
    senderId: String,
    senderRole: String,
    senderName: String,
    systemEventType: { type: String, default: null },
    systemEventData: { type: Schema.Types.Mixed, default: null },
    createdAt: Date,
  },
  { _id: false },
);

const RoomSchema = new Schema(
  {
    customerId: { type: String, required: true, unique: true, index: true },
    customerKey: { type: String },
    customerName: { type: String, required: true },
    admins: { type: [ParticipantSchema], default: [] },
    participants: { type: [ParticipantSchema], default: [] },
    lastMessage: { type: LastMessageSchema, default: null },
    unreadBy: { type: Map, of: Number, default: {} },
  },
  { timestamps: true },
);

// Sort rooms by latest activity
RoomSchema.index({ updatedAt: -1 });
// Fast per-user room listing (admin dashboard, customer sidebar)
RoomSchema.index({ "participants.userId": 1, updatedAt: -1 });
// For customerId lookups (already has unique index on customerId)
RoomSchema.index({ customerId: 1 }, { unique: true });

export type RoomDoc = InferSchemaType<typeof RoomSchema> & { _id: mongoose.Types.ObjectId };
export const Room = mongoose.model("ShopChatRoom", RoomSchema);
