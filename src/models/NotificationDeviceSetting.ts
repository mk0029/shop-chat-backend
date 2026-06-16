import mongoose, { Schema, type InferSchemaType } from "mongoose";

const NotificationDeviceSettingSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    allowedDevicesCount: { type: Number, default: 1, min: 1, max: 2 },
  },
  { timestamps: true },
);

export type NotificationDeviceSettingDoc = InferSchemaType<typeof NotificationDeviceSettingSchema> & {
  _id: mongoose.Types.ObjectId;
};
export const NotificationDeviceSetting = mongoose.model("NotificationDeviceSetting", NotificationDeviceSettingSchema);
