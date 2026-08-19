/**
 * 登録済みメール OTP を通過した受領者へ、 パスキー登録を 1 回だけ許可する grant。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export interface InvoiceShareEnrollmentGrantRow {
  id: string;
  share_id: string;
  contact_id: string;
  otp_challenge_id: string;
  grant_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface CreateInvoiceShareEnrollmentGrantInput {
  id: string;
  shareId: string;
  contactId: string;
  otpChallengeId: string;
  grantHash: string;
  createdAt: number;
  expiresAt: number;
}

export class InvoiceShareEnrollmentGrantRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateInvoiceShareEnrollmentGrantInput): InvoiceShareEnrollmentGrantRow {
    this.db.prepare(
      `INSERT INTO invoice_share_enrollment_grants
       (id, share_id, contact_id, otp_challenge_id, grant_hash, created_at, expires_at)
       VALUES (@id, @shareId, @contactId, @otpChallengeId, @grantHash, @createdAt, @expiresAt)`,
    ).run(input);
    return this.find(input.id)!;
  }

  find(id: string): InvoiceShareEnrollmentGrantRow | undefined {
    return this.db.prepare("SELECT * FROM invoice_share_enrollment_grants WHERE id = ?")
      .get(id) as InvoiceShareEnrollmentGrantRow | undefined;
  }

  consume(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE invoice_share_enrollment_grants SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?`,
    ).run(now, id, now).changes > 0;
  }
}
