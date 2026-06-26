import mongoose, { Schema, type InferSchemaType } from "mongoose";

const ReceiptSchema = new Schema(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ["admin", "super_admin", "technician", "customer"], required: true },
    name: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ReplyToSchema = new Schema(
  {
    messageId: String,
    text: String,
    senderId: String,
    senderName: String,
  },
  { _id: false },
);

const ReactionSchema = new Schema(
  {
    userId: { type: String, required: true },
    userName: String,
    emoji: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ChatMediaSchema = new Schema(
  {
    type: { type: String, enum: ["image", "video", "audio", "file"], required: true },
    url: { type: String, required: true },
    path: String,
    fileName: String,
    mimeType: String,
    size: Number,
    width: Number,
    height: Number,
    uploadedAt: Date,
  },
  { _id: false },
);

const MessageSchema = new Schema(
  {
    roomId: { type: Schema.Types.ObjectId, ref: "ShopChatRoom", required: true, index: true },
    clientMessageId: { type: String, index: true },
    type: { type: String, enum: ["text", "image", "video", "audio", "file"], default: "text" },
    text: { type: String, default: "" },
    attachments: { type: [Schema.Types.Mixed], default: [] },
    media: { type: ChatMediaSchema, default: null },
    senderId: { type: String, required: true, index: true },
    senderRole: { type: String, enum: ["admin", "super_admin", "technician", "customer"], required: true },
    senderName: { type: String, required: true },
    status: { type: String, enum: ["sending", "sent", "delivered", "read"], default: "sent" },
    deliveredTo: { type: [ReceiptSchema], default: [] },
    readBy: { type: [ReceiptSchema], default: [] },
    replyTo: { type: ReplyToSchema, default: null },
    forwarded: { type: Boolean, default: false },
    forwardedFrom: { type: String, default: null },
    messageKind: { type: String, enum: ["user", "system"], default: "user" },
    systemEventType: { type: String, default: null },
    systemEventData: { type: Schema.Types.Mixed, default: null },
    reactions: { type: [ReactionSchema], default: [] },
    hiddenFor: { type: [String], default: [] },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

MessageSchema.index(
  { roomId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } },
);
MessageSchema.index({ roomId: 1, createdAt: -1 });

export type MessageDoc = InferSchemaType<typeof MessageSchema> & { _id: mongoose.Types.ObjectId };
export const Message = mongoose.model("ShopChatMessage", MessageSchema);
