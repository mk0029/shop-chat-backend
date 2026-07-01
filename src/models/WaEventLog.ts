import mongoose, { Schema, type InferSchemaType } from "mongoose";

const WaEventLogSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    eventId: { type: String, required: true, index: true },
    status: { type: String, enum: ["reserved", "queued", "sent", "failed", "skipped"], default: "reserved", index: true },
    recipientJids: { type: [String], default: [] },
    messageIds: { type: [String], default: [] },
    payload: { type: Schema.Types.Mixed, default: {} },
    failureReason: { type: String, default: "" },
    skippedReason: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

WaEventLogSchema.index({ createdAt: -1 });
WaEventLogSchema.index({ eventType: 1, eventId: 1 });

export type WaEventLogDoc = InferSchemaType<typeof WaEventLogSchema> & { _id: mongoose.Types.ObjectId };
export const WaEventLog = mongoose.model("WaEventLog", WaEventLogSchema);
