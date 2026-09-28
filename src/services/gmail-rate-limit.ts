/** Sanitized provider diagnostics only; never retain response text or credentials. */
export class GmailRateLimit extends Error {
  readonly kind = "rate_limit";
  constructor(readonly retryAt: number, readonly status: number, readonly reason: string) {
    super("Gmail request budget exhausted");
  }
}

/** @implements SPEC-MAIL-CRAWLER-002 */
export async function checkGmailLimit(response: Response, now: number): Promise<void> {
  if (response.status !== 429 && response.status !== 403) return;
  const body = await response.clone().json().catch(() => null) as {
    error?: { errors?: { reason?: string }[]; message?: string };
  } | null;
  const allowed = ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"];
  const reason = body?.error?.errors?.map((entry) => entry.reason).find((value) => allowed.includes(value ?? ""));
  if (response.status === 403 && !reason) return;
  const retry = response.headers.get("Retry-After");
  const headerAt = retry && /^\d+(\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry ?? "");
  const timestamp = body?.error?.message?.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)?.[0];
  const messageAt = Date.parse(timestamp ?? "");
  throw new GmailRateLimit(Math.max(now + 60_000, Number.isFinite(headerAt) ? headerAt : 0,
    Number.isFinite(messageAt) ? messageAt : 0), response.status, reason ?? "tooManyRequests");
}
