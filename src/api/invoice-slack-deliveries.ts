/**
 * 請求書マジックリンクの Slack 配信エンドポイント。
 *
 * @implements SPEC-INVOICE-SLACK-001 (spec/feature/invoice-public-magic-link.md)
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { InvoiceShareError } from "../services/invoice-share-service.js";
import type { InvoiceSlackDeliveryService } from "../services/invoice-slack-delivery.js";
import { SlackDeliveryError, type SlackInvoiceTarget } from "../services/slack-web-api-client.js";
import { invoiceIdOf } from "./invoice-id.js";

const DeliverySchema = z.object({
  document_path: z.string().min(1).max(4096),
  expires_in_days: z.number().int().min(1).max(30).optional(),
  conversation_id: z.string().min(3).max(64).optional(),
  user_ids: z.array(z.string().min(3).max(64)).min(2).max(8).optional(),
  recipient_name: z.string().min(1).max(100).optional(),
  billing_period: z.string().min(1).max(100).optional(),
  recipient_id: z.string().uuid().optional(),
}).strict().refine(
  (value) => !(value.conversation_id && value.user_ids),
  { message: "conversation_id and user_ids cannot both be specified" },
);

export function invoiceSlackDeliveriesRouter(deps: { service: InvoiceSlackDeliveryService }): Hono {
  const app = new Hono();

  app.post("/:id/share-links/slack", async (c) => {
    const invoiceId = invoiceIdOf(c.req.param("id"));
    if (invoiceId === null) return c.json({ error: "invalid_id" }, 400);
    const parsed = DeliverySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.message }, 400);
    const target: SlackInvoiceTarget | undefined = parsed.data.conversation_id
      ? { conversationId: parsed.data.conversation_id }
      : parsed.data.user_ids ? { userIds: parsed.data.user_ids } : undefined;
    try {
      const delivered = await deps.service.deliver({
        invoiceId,
        documentPath: parsed.data.document_path,
        expiresInDays: parsed.data.expires_in_days,
        target,
        recipientName: parsed.data.recipient_name,
        billingPeriod: parsed.data.billing_period,
        deliveryContactId: parsed.data.recipient_id,
      });
      return c.json({
        share_id: delivered.id,
        expires_at: delivered.expiresAt,
        filename: delivered.filename,
        document_sha256: delivered.documentSha256,
        document_size: delivered.documentSize,
        recipient_id: delivered.recipientId,
        recipient_company: delivered.recipientCompany,
        recipient_email: delivered.recipientEmail,
        slack_conversation_id: delivered.conversationId,
        slack_message_ts: delivered.messageTs,
      }, 201);
    } catch (error) {
      return deliveryError(c, error);
    }
  });

  return app;
}

function deliveryError(c: Context, error: unknown) {
  if (error instanceof InvoiceShareError || error instanceof SlackDeliveryError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  return c.json({ error: "slack_delivery_failed" }, 500);
}
