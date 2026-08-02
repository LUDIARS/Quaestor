/**
 * 請求内容への明示合意を、共有リンクごとに一度だけ保存する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-002 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export interface InvoiceShareAcceptanceRow {
  id: string;
  share_id: string;
  invoice_id: number;
  recipient_company: string | null;
  recipient_email: string | null;
  document_sha256: string;
  agreement_version: string;
  agreement_text: string;
  accepted_at: number;
  cf_ray: string | null;
  user_agent_sha256: string;
  evidence_sha256: string;
}

export interface RecordInvoiceShareAcceptanceInput {
  id: string;
  shareId: string;
  invoiceId: number;
  recipientCompany: string | null;
  recipientEmail: string | null;
  documentSha256: string;
  agreementVersion: string;
  agreementText: string;
  acceptedAt: number;
  cfRay: string | null;
  userAgentSha256: string;
  evidenceSha256: string;
}

export class InvoiceShareAcceptanceRepo {
  constructor(private readonly db: Database.Database) {}

  record(input: RecordInvoiceShareAcceptanceInput): InvoiceShareAcceptanceRow {
    this.db.prepare(
      `INSERT INTO invoice_share_acceptances
       (id, share_id, invoice_id, recipient_company, recipient_email,
        document_sha256, agreement_version, agreement_text, accepted_at,
        cf_ray, user_agent_sha256, evidence_sha256)
       VALUES (@id, @shareId, @invoiceId, @recipientCompany, @recipientEmail,
               @documentSha256, @agreementVersion, @agreementText, @acceptedAt,
               @cfRay, @userAgentSha256, @evidenceSha256)
       ON CONFLICT(share_id) DO NOTHING`,
    ).run(input);
    return this.findByShareId(input.shareId)!;
  }

  findByShareId(shareId: string): InvoiceShareAcceptanceRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_acceptances WHERE share_id = ?",
    ).get(shareId) as InvoiceShareAcceptanceRow | undefined;
  }
}
