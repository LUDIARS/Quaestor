/**
 * Qs 内部配送の冪等キーと配送監査。 bearer URL / トークンは保持しない。
 *
 * @implements SPEC-INVOICE-EMAIL-002 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-EMAIL-003 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export type InvoiceShareDeliveryStatus = "pending" | "sent" | "failed";

export interface InvoiceShareDeliveryRow {
  id: string;
  idempotency_key: string;
  share_id: string;
  invoice_id: number;
  channel: "email" | "slack";
  destination_sha256: string;
  request_sha256: string;
  status: InvoiceShareDeliveryStatus;
  provider_message_id: string | null;
  failure_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface CreateInvoiceShareDeliveryInput {
  id: string;
  idempotencyKey: string;
  shareId: string;
  invoiceId: number;
  channel: "email" | "slack";
  destinationSha256: string;
  requestSha256: string;
  createdAt: number;
}

export class InvoiceShareDeliveryRepo {
  constructor(private readonly db: Database.Database) {}

  findByIdempotencyKey(key: string): InvoiceShareDeliveryRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_deliveries WHERE idempotency_key = ?",
    ).get(key) as InvoiceShareDeliveryRow | undefined;
  }

  insertPending(input: CreateInvoiceShareDeliveryInput): InvoiceShareDeliveryRow {
    this.db.prepare(
      `INSERT INTO invoice_share_deliveries
       (id, idempotency_key, share_id, invoice_id, channel, destination_sha256, request_sha256, status, created_at)
       VALUES (@id, @idempotencyKey, @shareId, @invoiceId, @channel, @destinationSha256, @requestSha256, 'pending', @createdAt)`,
    ).run(input);
    return this.findByIdempotencyKey(input.idempotencyKey)!;
  }

  markSent(id: string, providerMessageId: string, completedAt: number): InvoiceShareDeliveryRow {
    this.db.prepare(
      `UPDATE invoice_share_deliveries
       SET status = 'sent', provider_message_id = ?, completed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(providerMessageId, completedAt, id);
    return this.findById(id)!;
  }

  markFailed(id: string, failureCode: string, completedAt: number): InvoiceShareDeliveryRow {
    this.db.prepare(
      `UPDATE invoice_share_deliveries
       SET status = 'failed', failure_code = ?, completed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(failureCode, completedAt, id);
    return this.findById(id)!;
  }

  private findById(id: string): InvoiceShareDeliveryRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_deliveries WHERE id = ?",
    ).get(id) as InvoiceShareDeliveryRow | undefined;
  }
}
