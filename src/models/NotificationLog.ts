import mongoose, { Schema, type InferSchemaType } from "mongoose";

const DeliverySchema = new Schema(
  {
    tokenId: { type: String, default: "" },
    token: { type: String, default: "" },
    deviceId: { type: String, default: "" },
    status: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending" },
    failureReason: { type: String, default: "" },
    skippedReason: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  { _id: false },
);

const NotificationLogSchema = new Schema(
  {
    eventType: { type: String, required: true, index: true },
    normalizedEventType: { type: String, required: true, index: true },
    receiverUserId: { type: String, required: true, index: true },
    actorUserId: { type: String, default: "", index: true },
    status: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending", index: true },
    failureReason: { type: String, default: "" },
    skippedReason: { type: String, default: "" },
    eventId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    dedupeKey: { type: String, index: true, sparse: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    deliveries: { type: [DeliverySchema], default: [] },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

NotificationLogSchema.index({ createdAt: -1 });
NotificationLogSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export type NotificationLogDoc = InferSchemaType<typeof NotificationLogSchema> & { _id: mongoose.Types.ObjectId };
export const NotificationLog = mongoose.model("NotificationLog", NotificationLogSchema);
