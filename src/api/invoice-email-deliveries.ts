/**
 * 請求書マジックリンクのメール配信API。 応答へ bearer URL / トークンを含めない。
 *
 * @implements SPEC-INVOICE-EMAIL-002 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-EMAIL-003 (spec/feature/invoice-public-magic-link.md)
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { InvoiceEmailError } from "../services/invoice-email-notifier.js";
import type { InvoiceEmailDeliveryService } from "../services/invoice-email-delivery.js";
import { InvoiceShareError } from "../services/invoice-share-service.js";
import { invoiceIdOf } from "./invoice-id.js";

const DeliverySchema = z.object({
  document_path: z.string().min(1).max(4096),
  expires_in_days: z.number().int().min(1).max(30).optional(),
  recipient_id: z.string().uuid(),
  idempotency_key: z.string().uuid(),
  billing_period: z.string().min(1).max(100).optional(),
}).strict();

export function invoiceEmailDeliveriesRouter(deps: { service: InvoiceEmailDeliveryService }): Hono {
  const app = new Hono();
  app.post("/:id/share-links/email", async (c) => {
    const invoiceId = invoiceIdOf(c.req.param("id"));
    if (invoiceId === null) return c.json({ error: "invalid_id" }, 400);
    const parsed = DeliverySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.message }, 400);
    try {
      const result = await deps.service.deliver({
        invoiceId,
        documentPath: parsed.data.document_path,
        expiresInDays: parsed.data.expires_in_days,
        recipientId: parsed.data.recipient_id,
        idempotencyKey: parsed.data.idempotency_key,
        billingPeriod: parsed.data.billing_period,
      });
      return c.json({
        delivery_id: result.delivery.id,
        delivery_status: result.delivery.status,
        share_id: result.shareId,
        expires_at: result.expiresAt,
        filename: result.filename,
        document_sha256: result.documentSha256,
        recipient_company: result.recipientCompany,
        recipient_email: result.recipientEmail,
      }, 201);
    } catch (error) {
      return deliveryError(c, error);
    }
  });
  return app;
}

function deliveryError(c: Context, error: unknown) {
  if (error instanceof InvoiceShareError || error instanceof InvoiceEmailError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  return c.json({ error: "email_delivery_failed" }, 500);
}
