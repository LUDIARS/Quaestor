/**
 * 送信先 (契約先) が登録した WebAuthn 公開鍵の台帳。 秘密鍵は相手端末にしか存在しない。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export type PasskeyEnrollmentSource = "email_otp" | "contract_fingerprint";

export interface InvoiceRecipientPasskeyRow {
  id: string;
  contact_id: string;
  recipient_email_sha256: string;
  credential_id: string;
  public_key_cose: string;
  public_key_sha256: string;
  algorithm: number;
  sign_count: number;
  transports: string | null;
  aaguid: string | null;
  enrolled_via: PasskeyEnrollmentSource;
  enrollment_challenge_id: string | null;
  enrolled_share_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

export interface CreateInvoiceRecipientPasskeyInput {
  id: string;
  contactId: string;
  recipientEmailSha256: string;
  credentialId: string;
  publicKeyCose: string;
  publicKeySha256: string;
  algorithm: number;
  signCount: number;
  transports: string[] | null;
  aaguid: string | null;
  enrolledVia: PasskeyEnrollmentSource;
  enrollmentChallengeId: string | null;
  enrolledShareId: string | null;
  createdAt: number;
}

/** 管理画面へ返す公開可能な要約。 公開鍵本体は含めない。 */
export interface InvoiceRecipientPasskeySummary {
  id: string;
  contact_id: string;
  public_key_sha256: string;
  algorithm: number;
  enrolled_via: PasskeyEnrollmentSource;
  created_at: number;
  revoked_at: number | null;
}

export class InvoiceRecipientPasskeyRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateInvoiceRecipientPasskeyInput): InvoiceRecipientPasskeyRow {
    this.db.prepare(
      `INSERT INTO invoice_recipient_passkeys
       (id, contact_id, recipient_email_sha256, credential_id, public_key_cose, public_key_sha256, algorithm, sign_count,
        transports, aaguid, enrolled_via, enrollment_challenge_id, enrolled_share_id, created_at)
       VALUES (@id, @contactId, @recipientEmailSha256, @credentialId, @publicKeyCose, @publicKeySha256, @algorithm, @signCount,
               @transports, @aaguid, @enrolledVia, @enrollmentChallengeId, @enrolledShareId, @createdAt)`,
    ).run({ ...input, transports: input.transports ? JSON.stringify(input.transports) : null });
    return this.find(input.id)!;
  }

  find(id: string): InvoiceRecipientPasskeyRow | undefined {
    return this.db.prepare("SELECT * FROM invoice_recipient_passkeys WHERE id = ?")
      .get(id) as InvoiceRecipientPasskeyRow | undefined;
  }

  findActiveByCredentialId(credentialId: string): InvoiceRecipientPasskeyRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_recipient_passkeys WHERE credential_id = ? AND revoked_at IS NULL",
    ).get(credentialId) as InvoiceRecipientPasskeyRow | undefined;
  }

  /** contact のメール変更前に登録された鍵を、新しい受領者スナップショットへ持ち越さない。 */
  listActiveForRecipient(contactId: string, recipientEmailSha256: string): InvoiceRecipientPasskeyRow[] {
    return this.db.prepare(
      `SELECT * FROM invoice_recipient_passkeys
       WHERE contact_id = ? AND recipient_email_sha256 = ? AND revoked_at IS NULL
       ORDER BY created_at ASC`,
    ).all(contactId, recipientEmailSha256) as InvoiceRecipientPasskeyRow[];
  }

  listSummariesForContact(contactId: string): InvoiceRecipientPasskeySummary[] {
    return this.db.prepare(
      `SELECT id, contact_id, public_key_sha256, algorithm, enrolled_via, created_at, revoked_at
       FROM invoice_recipient_passkeys WHERE contact_id = ? ORDER BY created_at ASC`,
    ).all(contactId) as InvoiceRecipientPasskeySummary[];
  }

  /** 認証器カウンタは後退させない。 後退を検出した呼び出し側は署名を拒否する。 */
  updateSignCount(id: string, signCount: number): boolean {
    return this.db.prepare(
      "UPDATE invoice_recipient_passkeys SET sign_count = ? WHERE id = ? AND sign_count <= ?",
    ).run(signCount, id, signCount).changes > 0;
  }

  revoke(id: string, contactId: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE invoice_recipient_passkeys SET revoked_at = ?
       WHERE id = ? AND contact_id = ? AND revoked_at IS NULL`,
    ).run(now, id, contactId).changes > 0;
  }
}
