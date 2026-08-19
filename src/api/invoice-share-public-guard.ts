/**
 * 公開マジックリンク配下 (`/v1/invoices/share/*`) 共通のレート制限と応答ヘッダー。
 * 複数ルータが同じパス配下を持つため、 app.ts でパスに対して 1 回だけ掛ける (二重カウント防止)。
 *
 * @implements SPEC-INVOICE-ACCESS-002 (spec/feature/invoice-public-magic-link.md)
 */

import type { Context, MiddlewareHandler } from "hono";
import type { InvoiceShareRateLimiter } from "../services/invoice-share-rate-limiter.js";
import type { CloudflareVisitorLocation } from "../services/invoice-acceptance-location-signal.js";

/** 公開ページ共通 CSP。 パスキー用に同一 origin のスクリプトと fetch だけを許す。 */
export const PUBLIC_SHARE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
  + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function invoiceSharePublicGuard(rateLimiter: InvoiceShareRateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const rate = rateLimiter.check(clientAddress(c));
    if (!rate.allowed) {
      setPublicShareHeaders(c);
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
    setPublicShareHeaders(c);
  };
}

export function setPublicShareHeaders(c: Context): void {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (!c.res.headers.has("Content-Security-Policy")) {
    c.header("Content-Security-Policy", PUBLIC_SHARE_CSP);
  }
}

export function clientAddress(c: Context): string {
  return c.req.header("CF-Connecting-IP")
    ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

/**
 * Cloudflare の自己申告位置ヘッダー。 信頼判定と粗粒度への縮約は
 * evaluateAcceptanceLocation 側で行うため、 ここでは素通しする。
 */
export function visitorLocation(c: Context): CloudflareVisitorLocation {
  return {
    latitude: c.req.header("cf-iplatitude"),
    longitude: c.req.header("cf-iplongitude"),
    countryCode: c.req.header("cf-ipcountry"),
    regionCode: c.req.header("cf-region-code"),
  };
}

export function rejectCrossSite(c: Context): boolean {
  return c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site";
}
