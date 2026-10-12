import { MailInboxError } from "@ludiars/mail-inbox";
import { GmailRateLimit } from "./gmail-rate-limit.js";

export type MailCrawlStage = "list_ids" | "process";

/** Secret-free diagnostics. Exception messages are never copied; every field is a fixed vocabulary or number. */
export interface MailCrawlFailure {
  stage: MailCrawlStage; category: string; errorClass: string; at: number;
  code?: string; status?: number; reason?: string;
}

// Fixed library messages (no credential or mail content) that separate OAuth refresh outcomes.
const AUTH_MESSAGES: Record<string, string> = {
  "OAuth token refresh was rejected": "gmail_auth_refresh_rejected",
  "OAuth token refresh failed": "gmail_auth_network",
  "OAuth token response was invalid": "gmail_auth_invalid_response",
};
const SAFE_MESSAGES = new Set(["gmail_repeated_page", "gmail_invalid_page"]);

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}
function token(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}
function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** @implements SPEC-MAIL-CRAWLER-007 */
export function classifyMailCrawlFailure(error: unknown, stage: MailCrawlStage, at: number): MailCrawlFailure {
  const name = token(field(error, "name"));
  const errorClass = token(field(field(error, "constructor"), "name")) ?? name ?? "unknown";
  const message = error instanceof Error ? error.message : "";
  const code = token(field(error, "code")) ?? token(field(field(error, "cause"), "code"));
  const base = { stage, errorClass, at, ...(code ? { code } : {}) };
  if (error instanceof GmailRateLimit) {
    return { ...base, category: "gmail_rate_limit", reason: token(error.reason), ...(httpStatus(error.status) ? { status: error.status } : {}) };
  }
  if (error instanceof MailInboxError) {
    const status = httpStatus(error.status);
    const category = error.kind === "auth" ? AUTH_MESSAGES[message] ?? (status ? `gmail_${status}` : "gmail_auth")
      : error.kind === "network" ? "network" : `gmail_${token(error.kind) ?? "unknown"}`;
    return { ...base, category, ...(status ? { status } : {}) };
  }
  const http = /^gmail_http_(\d{3})$/.exec(message);
  if (http) return { ...base, category: `gmail_${http[1]}`, status: Number(http[1]) };
  if (SAFE_MESSAGES.has(message)) return { ...base, category: message };
  if (message === "Gmail is not configured") return { ...base, category: "gmail_unconfigured" };
  if (code && /^(?:mail_analysis_unconfigured|mail_luna_[a-z0-9_]+)$/.test(code)) return { ...base, category: code };
  if (name === "TimeoutError" || name === "AbortError") return { ...base, category: "network_timeout" };
  if (error instanceof TypeError && (message === "fetch failed" || field(error, "cause") !== undefined)) {
    return { ...base, category: "network" };
  }
  return { ...base, category: "unknown" };
}
