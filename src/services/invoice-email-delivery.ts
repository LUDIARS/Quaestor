/**
 * マジックリンク発行・Gmail配信・冪等監査を一つの失敗単位として扱う。
 *
 * @implements SPEC-INVOICE-EMAIL-002 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-EMAIL-003 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, randomUUID } from "node:crypto";
import type { InvoiceShareDeliveryRepo, InvoiceShareDeliveryRow } from "../db/invoice-share-delivery-repo.js";
import type { InvoiceRow, InvoicesRepo } from "../db/invoices-repo.js";
import type { InvoiceEmailNotifier } from "./invoice-email-notifier.js";
import { InvoiceEmailError } from "./invoice-email-notifier.js";
import { InvoiceShareError, type InvoiceShareService } from "./invoice-share-service.js";

export interface DeliverInvoiceToEmailInput {
  invoiceId: number;
  documentPath: string;
  expiresInDays?: number;
  recipientId: string;
  idempotencyKey: string;
  billingPeriod?: string;
}

export interface DeliveredInvoiceToEmail {
  delivery: InvoiceShareDeliveryRow;
  shareId: string;
  expiresAt: number;
  filename: string;
  documentSha256: string;
  recipientCompany: string;
  recipientEmail: string;
}

export interface InvoiceEmailDeliveryOptions {
  invoices: InvoicesRepo;
  shares: InvoiceShareService;
  deliveries: InvoiceShareDeliveryRepo;
  notifier?: InvoiceEmailNotifier;
  now?: () => number;
  idFactory?: () => string;
}

export class InvoiceEmailDeliveryService {
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: InvoiceEmailDeliveryOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async deliver(input: DeliverInvoiceToEmailInput): Promise<DeliveredInvoiceToEmail> {
    const requestSha256 = sha256(JSON.stringify({
      invoiceId: input.invoiceId,
      documentPath: input.documentPath,
      expiresInDays: input.expiresInDays ?? 14,
      recipientId: input.recipientId,
      billingPeriod: input.billingPeriod?.trim() ?? null,
    }));
    const previous = this.options.deliveries.findByIdempotencyKey(input.idempotencyKey);
    if (previous) return this.resolveExisting(previous, input, requestSha256);
    const notifier = this.options.notifier;
    if (!notifier) throw new InvoiceEmailError("not_configured", "Gmail ADC is not configured", 503);
    notifier.assertReady();

    const invoice = this.options.invoices.find(input.invoiceId);
    if (!invoice || invoice.status === "cancelled") {
      throw new InvoiceShareError("not_found", "invoice not found", 404);
    }
    const share = await this.options.shares.create({
      invoiceId: input.invoiceId,
      documentPath: input.documentPath,
      expiresInDays: input.expiresInDays,
      recipientId: input.recipientId,
    });
    if (!share.recipientEmail || !share.recipientCompany) {
      this.options.shares.revoke(input.invoiceId, share.id);
      throw new InvoiceShareError("invalid_request", "an active email recipient is required", 400);
    }
    let delivery: InvoiceShareDeliveryRow;
    try {
      delivery = this.options.deliveries.insertPending({
        id: this.idFactory(),
        idempotencyKey: input.idempotencyKey,
        shareId: share.id,
        invoiceId: input.invoiceId,
        channel: "email",
        destinationSha256: sha256(share.recipientEmail.trim().toLowerCase()),
        requestSha256,
        createdAt: this.now(),
      });
    } catch (error) {
      this.options.shares.revoke(input.invoiceId, share.id);
      const raced = this.options.deliveries.findByIdempotencyKey(input.idempotencyKey);
      if (raced) return this.resolveExisting(raced, input, requestSha256);
      throw error;
    }

    try {
      const sent = await notifier.sendMessage({
        to: share.recipientEmail,
        ...deliveryMessage(invoice, share.url, share.recipientCompany, share.expiresAt, input.billingPeriod),
      });
      const completed = this.options.deliveries.markSent(delivery.id, sent.messageId, this.now());
      return {
        delivery: completed,
        shareId: share.id,
        expiresAt: share.expiresAt,
        filename: share.filename,
        documentSha256: share.documentSha256,
        recipientCompany: share.recipientCompany,
        recipientEmail: share.recipientEmail,
      };
    } catch (error) {
      this.options.shares.revoke(input.invoiceId, share.id);
      this.options.deliveries.markFailed(delivery.id, safeFailureCode(error), this.now());
      throw error;
    }
  }

  private resolveExisting(
    row: InvoiceShareDeliveryRow,
    input: DeliverInvoiceToEmailInput,
    requestSha256: string,
  ): DeliveredInvoiceToEmail {
    if (row.invoice_id !== input.invoiceId || row.channel !== "email" || row.request_sha256 !== requestSha256) {
      throw new InvoiceShareError("invalid_request", "idempotency key belongs to another delivery", 409);
    }
    if (row.status !== "sent") {
      throw new InvoiceEmailError("api_error", `email delivery is ${row.status}; automatic retry is disabled`, 502);
    }
    const share = this.options.shares.findById(row.share_id);
    if (!share?.recipient_company || !share.recipient_email) {
      throw new InvoiceEmailError("api_error", "email delivery audit is incomplete", 502);
    }
    return {
      delivery: row,
      shareId: share.id,
      expiresAt: share.expires_at,
      filename: share.filename,
      documentSha256: share.document_sha256,
      recipientCompany: share.recipient_company,
      recipientEmail: share.recipient_email,
    };
  }
}

function deliveryMessage(
  invoice: InvoiceRow,
  url: string,
  recipientCompany: string,
  expiresAtEpochSeconds: number,
  billingPeriod?: string,
): { subject: string; text: string } {
  const subjectName = billingPeriod?.trim() || invoice.work_summary;
  const expiresAt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", dateStyle: "long", timeStyle: "short",
  }).format(new Date(expiresAtEpochSeconds * 1000));
  return {
    subject: `【請求書送付】${subjectName}`,
    text: [
      `${recipientCompany} ご担当者様`,
      "",
      "いつもお世話になっております。",
      `${subjectName}の請求書をご用意しました。`,
      "以下のリンクから内容をご確認ください。PDFはメールに添付しておりません。",
      "",
      url,
      "",
      `リンク有効期限: ${expiresAt}`,
      "リンクは第三者へ転送しないようお願いいたします。",
    ].join("\n"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFailureCode(error: unknown): string {
  if (error instanceof InvoiceEmailError) return error.code;
  return "unknown";
}
