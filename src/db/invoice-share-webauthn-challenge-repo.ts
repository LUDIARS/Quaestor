/**
 * パスキー登録/署名の一回限り challenge。 challenge 平文は保持せず、 トークン鍵付き HMAC で照合する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export type WebAuthnChallengePurpose = "register" | "assert";

export interface InvoiceShareWebAuthnChallengeRow {
  id: string;
  share_id: string;
  purpose: WebAuthnChallengePurpose;
  statement_json: string | null;
  challenge_hash: string;
  enrollment_grant_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface CreateInvoiceShareWebAuthnChallengeInput {
  id: string;
  shareId: string;
  purpose: WebAuthnChallengePurpose;
  statementJson: string | null;
  challengeHash: string;
  enrollmentGrantId: string | null;
  createdAt: number;
  expiresAt: number;
}

export class InvoiceShareWebAuthnChallengeRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateInvoiceShareWebAuthnChallengeInput): InvoiceShareWebAuthnChallengeRow {
    this.db.prepare(
      `INSERT INTO invoice_share_webauthn_challenges
       (id, share_id, purpose, statement_json, challenge_hash, enrollment_grant_id, created_at, expires_at)
       VALUES (@id, @shareId, @purpose, @statementJson, @challengeHash, @enrollmentGrantId, @createdAt, @expiresAt)`,
    ).run(input);
    return this.find(input.id)!;
  }

  find(id: string): InvoiceShareWebAuthnChallengeRow | undefined {
    return this.db.prepare("SELECT * FROM invoice_share_webauthn_challenges WHERE id = ?")
      .get(id) as InvoiceShareWebAuthnChallengeRow | undefined;
  }

  /** 未消費・未期限の challenge だけを 1 回消費する。 */
  consume(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE invoice_share_webauthn_challenges SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?`,
    ).run(now, id, now).changes > 0;
  }

  /** 発行総数。 リンク所持者が challenge を無限に発行して行を増やすのを閉じる。 */
  countForShare(shareId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS count FROM invoice_share_webauthn_challenges WHERE share_id = ?",
    ).get(shareId) as { count: number }).count;
  }
}
