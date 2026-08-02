import type Database from "better-sqlite3";

export interface InvoiceShareRow {
  id: string;
  invoice_id: number;
  token_hash: string;
  document_path: string;
  document_sha256: string;
  document_size: number;
  filename: string;
  recipient_id: string | null;
  recipient_company: string | null;
  recipient_email: string | null;
  expires_at: number;
  revoked_at: number | null;
  first_viewed_at: number | null;
  last_viewed_at: number | null;
  view_count: number;
  created_at: number;
}

export interface CreateInvoiceShareInput {
  id: string;
  invoiceId: number;
  tokenHash: string;
  documentPath: string;
  documentSha256: string;
  documentSize: number;
  filename: string;
  recipientId?: string | null;
  recipientCompany?: string | null;
  recipientEmail?: string | null;
  expiresAt: number;
  createdAt: number;
}

export class InvoiceShareRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateInvoiceShareInput): InvoiceShareRow {
    this.db.prepare(
      `INSERT INTO invoice_share_tokens
       (id, invoice_id, token_hash, document_path, document_sha256, document_size,
        filename, recipient_id, recipient_company, recipient_email, expires_at, created_at)
       VALUES (@id, @invoiceId, @tokenHash, @documentPath, @documentSha256,
               @documentSize, @filename, @recipientId, @recipientCompany, @recipientEmail,
               @expiresAt, @createdAt)`,
    ).run({
      ...input,
      recipientId: input.recipientId ?? null,
      recipientCompany: input.recipientCompany ?? null,
      recipientEmail: input.recipientEmail ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): InvoiceShareRow | undefined {
    return this.db.prepare(
      `SELECT * FROM invoice_share_tokens WHERE id = ?`,
    ).get(id) as InvoiceShareRow | undefined;
  }

  findActiveByTokenHash(tokenHash: string, now: number): InvoiceShareRow | undefined {
    return this.db.prepare(
      `SELECT * FROM invoice_share_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at >= ?`,
    ).get(tokenHash, now) as InvoiceShareRow | undefined;
  }

  recordView(id: string, now: number): boolean {
    const result = this.db.prepare(
      `UPDATE invoice_share_tokens
       SET first_viewed_at = COALESCE(first_viewed_at, ?),
           last_viewed_at = ?,
           view_count = view_count + 1
       WHERE id = ? AND revoked_at IS NULL AND expires_at >= ?`,
    ).run(now, now, id, now);
    return result.changes > 0;
  }

  revoke(id: string, invoiceId: number, now: number): boolean {
    const result = this.db.prepare(
      `UPDATE invoice_share_tokens
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND invoice_id = ?`,
    ).run(now, id, invoiceId);
    return result.changes > 0;
  }
}
