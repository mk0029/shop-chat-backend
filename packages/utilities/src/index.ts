export function generateIdempotencyKey(userId: string, resource: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `${userId}:${resource}:${timestamp}:${random}`;
}

export function generateClientMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function generateUploadId(): string {
  return `upl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function isPermanentUploadError(errorMessage: string): boolean {
  const permanent = [
    "File too large",
    "Unsupported file type",
    "Local file not found",
    "Room access denied",
    "Account disabled",
    "Upload rejected",
    "File not found",
  ];
  return permanent.some((p) => errorMessage.toLowerCase().includes(p.toLowerCase()));
}

export function calculateExponentialBackoff(
  retryCount: number,
  baseDelayMs = 5000,
  maxDelayMs = 1800000
): number {
  const delay = Math.min(baseDelayMs * Math.pow(3, retryCount), maxDelayMs);
  const jitter = Math.random() * 0.3 * delay;
  return delay + jitter;
}

export const UPLOAD_RETRY_DELAYS = [5000, 15000, 45000, 120000, 300000, 600000, 1200000, 1800000];

export const MAX_FILE_SIZES = {
  image: 10 * 1024 * 1024,
  document: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 50 * 1024 * 1024,
} as const;

export const ALLOWED_MIME_PREFIXES = [
  "image/", "video/", "audio/", "application/pdf",
  "application/zip", "text/", "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml",
  "application/json",
] as const;
