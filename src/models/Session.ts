import mongoose, { Schema, type InferSchemaType } from "mongoose";

const SessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    deviceId: { type: String, default: "", index: true },
    deviceName: { type: String, default: "" },
    browser: { type: String, default: "" },
    os: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "replaced", "expired", "logged_out"],
      default: "active",
      index: true,
    },
    replacedBySessionId: { type: String, default: null },
    replacedAt: { type: Date, default: null },
    replacedByDeviceName: { type: String, default: "" },
    issuedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

SessionSchema.index({ userId: 1, status: 1 });
SessionSchema.index({ sessionId: 1, userId: 1 });

export type SessionDoc = InferSchemaType<typeof SessionSchema> & { _id: mongoose.Types.ObjectId };
export const Session = mongoose.model("Session", SessionSchema);
