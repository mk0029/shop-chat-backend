import { waQueue } from "./waQueue.service";
import { renderWaTemplate, type WaEventType } from "./waTemplates.service";
import { waLogger } from "./waLogger.service";

type SendEventMessageInput = {
  eventType: WaEventType;
  eventId: string;
  idempotencyKey: string;
  jid: string;
  payload: Record<string, any>;
};

class WaMessageService {
  buildMessage(eventType: WaEventType, payload: Record<string, any>) {
    return renderWaTemplate(eventType, payload);
  }

  async sendEventMessage(input: SendEventMessageInput) {
    const text = this.buildMessage(input.eventType, input.payload);
    waLogger.messageGenerated(input.eventType, input.idempotencyKey);
    const job = waQueue.enqueue({
      eventType: input.eventType,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      jid: input.jid,
      text,
    });
    return { queued: true, jobId: job.id, jid: input.jid };
  }
}

export const waMessageService = new WaMessageService();
