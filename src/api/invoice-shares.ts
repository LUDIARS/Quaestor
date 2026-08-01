import { Hono, type Context } from "hono";
import { z } from "zod";
import { invalidInvoiceSharePage, invoiceSharePage } from "../invoices/invoice-share-page.js";
import { InvoiceShareError, type InvoiceShareService } from "../services/invoice-share-service.js";
import type { InvoiceShareRateLimiter } from "../services/invoice-share-rate-limiter.js";

const CreateShareSchema = z.object({
  document_path: z.string().min(1).max(4096),
  expires_in_days: z.number().int().min(1).max(30).optional(),
}).strict();

export function invoiceSharesRouter(deps: {
  service: InvoiceShareService;
  rateLimiter: InvoiceShareRateLimiter;
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
      const result = await deps.service.findPublic(c.req.param("token"));
      return c.html(invoiceSharePage({
        token: c.req.param("token"),
        invoice: result.invoice,
        expiresAt: result.share.expires_at,
      }));
    } catch (error) {
      return publicShareError(c, error);
    }
  });

  app.get("/share/:token/document.pdf", async (c) => {
    try {
      const result = await deps.service.loadDocument(c.req.param("token"));
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

  app.post("/:id/share-links", async (c) => {
    const invoiceId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isSafeInteger(invoiceId)) return c.json({ error: "invalid_id" }, 400);
    const parsed = CreateShareSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.message }, 400);
    try {
      const created = await deps.service.create({
        invoiceId,
        documentPath: parsed.data.document_path,
        expiresInDays: parsed.data.expires_in_days,
      });
      return c.json({
        share_id: created.id,
        share_url: created.url,
        expires_at: created.expiresAt,
        filename: created.filename,
        document_sha256: created.documentSha256,
        document_size: created.documentSize,
      }, 201);
    } catch (error) {
      return adminShareError(c, error);
    }
  });

  app.post("/:id/share-links/:shareId/revoke", (c) => {
    const invoiceId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isSafeInteger(invoiceId)) return c.json({ error: "invalid_id" }, 400);
    const revoked = deps.service.revoke(invoiceId, c.req.param("shareId"));
    return revoked ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  return app;
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
