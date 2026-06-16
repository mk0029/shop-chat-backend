import mongoose, { Schema, type InferSchemaType } from "mongoose";

const FcmTokenSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    deviceId: { type: String, default: "", index: true },
    deviceName: { type: String, default: "" },
    platform: { type: String, default: "" },
    role: { type: String, default: "", index: true },
    isActive: { type: Boolean, default: true, index: true },
    lastSeen: { type: Date, default: Date.now },
    deactivatedAt: { type: Date, default: null },
    deactivatedReason: { type: String, default: "" },
  },
  { timestamps: true },
);

FcmTokenSchema.index({ userId: 1, isActive: 1, updatedAt: -1 });
FcmTokenSchema.index({ userId: 1, deviceId: 1 });
FcmTokenSchema.index({ role: 1, isActive: 1, updatedAt: -1 });

export type FcmTokenDoc = InferSchemaType<typeof FcmTokenSchema> & { _id: mongoose.Types.ObjectId };
export const FcmToken = mongoose.model("FcmToken", FcmTokenSchema);
