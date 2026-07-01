import { env } from "../../config/env";

export type PhoneNormalizationResult =
  | { ok: true; jid: string; digits: string; input: string }
  | { ok: false; reason: string; input: string };

export function sanitizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizePhoneToJid(value: unknown): PhoneNormalizationResult {
  const input = String(value || "").trim();
  const digits = sanitizePhone(input);
  if (!digits) return { ok: false, reason: "phone_missing", input };

  const withoutLeadingZeros = digits.replace(/^0+/, "");
  const full = withoutLeadingZeros.length === 10 ? `${env.waDefaultCountryCode}${withoutLeadingZeros}` : withoutLeadingZeros;
  if (full.length < 10 || full.length > 15) return { ok: false, reason: "phone_invalid", input };
  return { ok: true, jid: `${full}@s.whatsapp.net`, digits: full, input };
}

export function normalizePhoneList(values: unknown[]): { jids: string[]; skipped: Array<{ input: string; reason: string }> } {
  const seen = new Set<string>();
  const jids: string[] = [];
  const skipped: Array<{ input: string; reason: string }> = [];
  for (const value of values) {
    const result = normalizePhoneToJid(value);
    if (!result.ok) {
      skipped.push({ input: result.input, reason: result.reason });
      continue;
    }
    if (!seen.has(result.jid)) {
      seen.add(result.jid);
      jids.push(result.jid);
    }
  }
  return { jids, skipped };
}
