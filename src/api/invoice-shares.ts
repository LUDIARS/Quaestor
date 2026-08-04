/**
 * 請求書マジックリンクの発行・閲覧・受領者メール C&R・明示合意API。
 *
 * @implements SPEC-INVOICE-DELIVERY-002 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-003 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-004 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCESS-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCESS-002 (spec/feature/invoice-public-magic-link.md)
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { invalidInvoiceSharePage, invoiceSharePage } from "../invoices/invoice-share-page.js";
import {
  invoiceShareChallengePage,
  invoiceShareChallengeUnavailablePage,
} from "../invoices/invoice-share-challenge-page.js";
import { InvoiceShareError, type InvoiceShareService } from "../services/invoice-share-service.js";
import type { InvoiceShareRateLimiter } from "../services/invoice-share-rate-limiter.js";
import {
  InvoiceShareChallengeError,
  MASKED_RECIPIENT_EMAIL_FALLBACK,
  type InvoiceShareAcceptanceService,
} from "../services/invoice-share-acceptance-service.js";
import { InvoiceEmailError } from "../services/invoice-email-notifier.js";
import type { InvoiceShareAccessService } from "../services/invoice-share-access-service.js";
import type { CloudflareVisitorLocation } from "../services/invoice-acceptance-location-signal.js";

const DEFAULT_ACCESS_LOG_LIMIT = 100;
const MAX_ACCESS_LOG_LIMIT = 500;

const CreateShareSchema = z.object({
  document_path: z.string().min(1).max(4096),
  expires_in_days: z.number().int().min(1).max(30).optional(),
  recipient_id: z.string().uuid().optional(),
}).strict();

export function invoiceSharesRouter(deps: {
  service: InvoiceShareService;
  rateLimiter: InvoiceShareRateLimiter;
  acceptances: InvoiceShareAcceptanceService;
  accesses: InvoiceShareAccessService;
  allowUnsafeIssueApi?: boolean;
}): Hono {
  const app = new Hono();

  app.use("/share/*", async (c, next) => {
    const rate = deps.rateLimiter.check(clientAddress(c));
    if (!rate.allowed) {
      setPublicShareHeaders(c);
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
    setPublicShareHeaders(c);
  });

  app.get("/share/:token", async (c) => {
    try {
      const result = await deps.service.findPublic(c.req.param("token"), false);
      deps.accesses.record({
        share: result.share,
        eventType: "landing_view",
        ...accessMetadata(c),
      });
      const acceptance = deps.acceptances.find(result.share.id);
      return c.html(invoiceSharePage({
        token: c.req.param("token"),
        invoice: result.invoice,
        expiresAt: result.share.expires_at,
        documentSha256: result.share.document_sha256,
        recipientCompany: result.share.recipient_company,
        acceptedAt: acceptance?.accepted_at,
      }));
    } catch (error) {
      return publicShareError(c, error);
    }
  });

  app.post("/share/:token/accept", async (c) => {
    if (c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") {
      return c.html(invalidInvoiceSharePage(), 403);
    }
    const body = await c.req.parseBody().catch(() => ({} as Record<string, string | File>));
    // 両フェーズを同じ /accept に載せるため、 body のフィールドで分岐する。
    // challenge_id / code が片方だけでも確認フェーズ扱いにするのは、 壊れた確認
    // POST が黙って新しい challenge 発行 (= 追加のコードメール) に化けないため。
    if (typeof body["challenge_id"] === "string" || typeof body["code"] === "string") {
      return confirmAcceptance(c, body, deps);
    }
    if (body["confirm"] !== "accepted") return c.html(invalidInvoiceSharePage(), 400);
    try {
      const challenge = await deps.acceptances.begin({ token: c.req.param("token") });
      return c.html(invoiceShareChallengePage({
        token: c.req.param("token"),
        challengeId: challenge.challengeId,
        maskedEmail: challenge.maskedEmail,
        expiresAt: challenge.expiresAt,
      }));
    } catch (error) {
      if (error instanceof InvoiceShareChallengeError || error instanceof InvoiceEmailError) {
        return c.html(invoiceShareChallengeUnavailablePage(), error.status);
      }
      return publicShareError(c, error);
    }
  });

  // 後方互換の確認エイリアス。 新しい challenge ページはこの子パスに依存しない。
  // @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
  app.post("/share/:token/accept/confirm", async (c) => {
    if (c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") {
      return c.html(invalidInvoiceSharePage(), 403);
    }
    const body = await c.req.parseBody().catch(() => ({} as Record<string, string | File>));
    return confirmAcceptance(c, body, deps);
  });

  app.get("/share/:token/document.pdf", async (c) => {
    try {
      const result = await deps.service.loadDocument(c.req.param("token"), false);
      deps.accesses.record({
        share: result.share,
        eventType: "document_view",
        ...accessMetadata(c),
      });
      c.header("Content-Type", "application/pdf");
      c.header(
        "Content-Disposition",
        `inline; filename="invoice.pdf"; filename*=UTF-8''${encodeURIComponent(result.share.filename)}`,
      );
      c.header("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'");
      const responseBody = new Uint8Array(result.contents.byteLength);
      responseBody.set(result.contents);
      return c.body(responseBody.buffer);
    } catch (error) {
      return publicShareError(c, error);
    }
  });

  if (deps.allowUnsafeIssueApi) app.post("/:id/share-links", async (c) => {
    const invoiceId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isSafeInteger(invoiceId)) return c.json({ error: "invalid_id" }, 400);
    const parsed = CreateShareSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.message }, 400);
    try {
      const created = await deps.service.create({
        invoiceId,
        documentPath: parsed.data.document_path,
        expiresInDays: parsed.data.expires_in_days,
        recipientId: parsed.data.recipient_id,
      });
      return c.json({
        share_id: created.id,
        share_url: created.url,
        expires_at: created.expiresAt,
        filename: created.filename,
        document_sha256: created.documentSha256,
        document_size: created.documentSize,
        recipient_id: created.recipientId,
        recipient_company: created.recipientCompany,
        recipient_email: created.recipientEmail,
      }, 201);
    } catch (error) {
      return adminShareError(c, error);
    }
  });

  app.get("/:id/share-links/:shareId/acceptance", (c) => {
    const invoiceId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isSafeInteger(invoiceId)) return c.json({ error: "invalid_id" }, 400);
    const share = deps.service.findById(c.req.param("shareId"));
    if (!share || share.invoice_id !== invoiceId) return c.json({ error: "not_found" }, 404);
    const acceptance = deps.acceptances.find(share.id);
    return acceptance ? c.json({ acceptance }) : c.json({ error: "not_found" }, 404);
  });

  app.get("/:id/share-links/:shareId/access-logs", (c) => {
    const invoiceId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isSafeInteger(invoiceId)) return c.json({ error: "invalid_id" }, 400);
    const limit = accessLogLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "invalid_limit" }, 400);
    const share = deps.service.findById(c.req.param("shareId"));
    if (!share || share.invoice_id !== invoiceId) return c.json({ error: "not_found" }, 404);
    return c.json(deps.accesses.list(share.id, limit));
  });

  app.post("/:id/share-links/:shareId/revoke", (c) => {
    const invoiceId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isSafeInteger(invoiceId)) return c.json({ error: "invalid_id" }, 400);
    const revoked = deps.service.revoke(invoiceId, c.req.param("shareId"));
    return revoked ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  return app;
}

/**
 * 確認コード (OTP) フェーズの共通処理。
 * `/accept` と後方互換の `/accept/confirm` の双方から呼ばれる。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-003 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-004 (spec/feature/invoice-public-magic-link.md)
 */
async function confirmAcceptance(
  c: Context,
  body: Record<string, string | File>,
  deps: {
    service: InvoiceShareService;
    acceptances: InvoiceShareAcceptanceService;
  },
) {
  const token = c.req.param("token");
  if (!token) return c.html(invalidInvoiceSharePage(), 400);
  const challengeId = typeof body["challenge_id"] === "string" ? body["challenge_id"] : "";
  const code = typeof body["code"] === "string" ? body["code"].trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) {
    return c.html(invalidInvoiceSharePage(), 400);
  }
  try {
    const acceptance = await deps.acceptances.confirm({
      token, challengeId, code,
      cfRay: c.req.header("CF-Ray"), userAgent: c.req.header("user-agent"),
      cloudflareClientAddress: c.req.header("CF-Connecting-IP"),
      visitorLocation: visitorLocation(c),
    });
    const result = await deps.service.findPublic(token, false);
    return c.html(invoiceSharePage({
      token, invoice: result.invoice,
      expiresAt: result.share.expires_at, documentSha256: result.share.document_sha256,
      recipientCompany: result.share.recipient_company, acceptedAt: acceptance.accepted_at,
    }));
  } catch (error) {
    if (error instanceof InvoiceShareChallengeError) {
      return c.html(invoiceShareChallengePage({
        token, challengeId,
        maskedEmail: MASKED_RECIPIENT_EMAIL_FALLBACK,
        error: challengeErrorMessage(error),
      }), error.status);
    }
    return publicShareError(c, error);
  }
}

function challengeErrorMessage(error: InvoiceShareChallengeError): string {
  if (error.code === "expired") return "確認コードの有効期限が切れました。前の画面から再発行してください。";
  if (error.code === "locked") return "入力回数の上限に達しました。前の画面から再発行してください。";
  return "確認コードが一致しません。";
}

function setPublicShareHeaders(c: Context): void {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (!c.res.headers.has("Content-Security-Policy")) {
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  }
}

function clientAddress(c: Context): string {
  return c.req.header("CF-Connecting-IP")
    ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

/**
 * Cloudflare の自己申告位置ヘッダー。 信頼判定と粗粒度への縮約は
 * evaluateAcceptanceLocation 側で行うため、 ここでは素通しする。
 */
function visitorLocation(c: Context): CloudflareVisitorLocation {
  return {
    latitude: c.req.header("cf-iplatitude"),
    longitude: c.req.header("cf-iplongitude"),
    countryCode: c.req.header("cf-ipcountry"),
    regionCode: c.req.header("cf-region-code"),
  };
}

function accessMetadata(c: Context): {
  clientAddress: string;
  cfRay: string | undefined;
  userAgent: string | undefined;
  cloudflareClientAddress: string | undefined;
  visitorLocation: CloudflareVisitorLocation;
} {
  return {
    clientAddress: clientAddress(c),
    cfRay: c.req.header("CF-Ray"),
    userAgent: c.req.header("user-agent"),
    cloudflareClientAddress: c.req.header("CF-Connecting-IP"),
    visitorLocation: visitorLocation(c),
  };
}

function accessLogLimit(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_ACCESS_LOG_LIMIT;
  // `1e2` / ` 100` / `0x64` のような別表記を弾き、十進整数だけを受け取る。
  if (!/^\d{1,4}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_ACCESS_LOG_LIMIT ? parsed : null;
}

function publicShareError(c: Context, error: unknown) {
  if (error instanceof InvoiceShareError && error.code === "document_changed") {
    return c.html(invalidInvoiceSharePage(), 409);
  }
  return c.html(invalidInvoiceSharePage(), 404);
}

function adminShareError(c: Context, error: unknown) {
  if (error instanceof InvoiceShareError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  return c.json({ error: "invoice_share_failed" }, 500);
}
