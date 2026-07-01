import { WaEventLog } from "../../models/WaEventLog";
import { waLogger } from "./waLogger.service";

class WaIdempotencyService {
  async reserve(input: { idempotencyKey: string; eventType: string; eventId: string; payload: Record<string, unknown> }) {
    const result = await WaEventLog.findOneAndUpdate(
      { idempotencyKey: input.idempotencyKey },
      {
        $setOnInsert: {
          idempotencyKey: input.idempotencyKey,
          eventType: input.eventType,
          eventId: input.eventId,
          payload: input.payload,
          status: "reserved",
        },
      },
      { upsert: true, new: true, rawResult: true } as any,
    );
    const updatedExisting = Boolean((result as any).lastErrorObject?.updatedExisting);
    const doc = (result as any).value || result;
    if (updatedExisting && ["sent", "queued", "reserved"].includes(String(doc?.status || ""))) {
      waLogger.duplicateSkipped(input.eventType, input.idempotencyKey);
      return { duplicate: true, doc };
    }
    return { duplicate: false, doc };
  }

  async markSkipped(idempotencyKey: string, reason: string) {
    await WaEventLog.updateOne({ idempotencyKey }, { $set: { status: "skipped", skippedReason: reason } });
  }
}

export const waIdempotency = new WaIdempotencyService();
