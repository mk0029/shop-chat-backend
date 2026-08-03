import { env } from "../config/env";

export type WaSendResult = {
  ok: boolean;
  phone: string;
  error?: string;
  messageId?: string;
  retryable?: boolean;
};

function getOpenWaBaseUrl(): string {
  return (env.openwaUrl || "").replace(/\/+$/, "");
}

function getOpenWaApiKey(): string {
  return env.openwaApiKey || "";
}

function getOpenWaSessionId(): string {
  return process.env.OPENWA_SESSION_ID || "";
}

export function isWaConfigured(): boolean {
  return Boolean(getOpenWaApiKey() && getOpenWaSessionId() && getOpenWaBaseUrl());
}

function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits;
}

export async function sendWaText(phone: string, message: string): Promise<WaSendResult> {
  const baseUrl = getOpenWaBaseUrl();
  const apiKey = getOpenWaApiKey();
  const sessionId = getOpenWaSessionId();

  if (!baseUrl || !apiKey || !sessionId) {
    return { ok: false, phone, error: "WhatsApp bot not configured", retryable: false };
  }

  const e164 = normalizePhone(phone);
  if (e164.length < 12) {
    return { ok: false, phone, error: "Invalid phone number", retryable: false };
  }

  const chatId = `${e164}@c.us`;

  try {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages/send-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ chatId, text: message }),
      signal: AbortSignal.timeout(30_000),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errorMsg = json?.message || json?.error || `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, phone, error: errorMsg, retryable };
    }

    return { ok: true, phone, messageId: json?.messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, phone, error: msg, retryable: true };
  }
}

export async function sendWaBulk(
  messages: { phone: string; message: string }[],
  gapMs = 10_000,
): Promise<{ sent: number; failed: number; results: WaSendResult[] }> {
  const results: WaSendResult[] = [];
  for (const { phone, message } of messages) {
    if (results.length > 0) {
      await new Promise((r) => setTimeout(r, gapMs + Math.floor(Math.random() * 5000)));
    }
    results.push(await sendWaText(phone, message));
  }
  return {
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
