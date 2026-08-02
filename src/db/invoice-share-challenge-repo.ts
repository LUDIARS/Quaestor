/**
 * 受領者メール C&R の一時 challenge 永続化。 コード平文は保持しない。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-003 (spec/feature/invoice-public-magic-link.md)
 */

import type Database from "better-sqlite3";

export interface InvoiceShareChallengeRow {
  id: string;
  share_id: string;
  channel: "email";
  destination_sha256: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  attempt_count: number;
  max_attempts: number;
  consumed_at: number | null;
}

export interface CreateInvoiceShareChallengeInput {
  id: string;
  shareId: string;
  destinationSha256: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  maxAttempts: number;
}

export class InvoiceShareChallengeRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateInvoiceShareChallengeInput): InvoiceShareChallengeRow {
    this.db.prepare(
      `INSERT INTO invoice_share_challenges
       (id, share_id, channel, destination_sha256, code_hash,
        created_at, expires_at, max_attempts)
       VALUES (@id, @shareId, 'email', @destinationSha256, @codeHash,
               @createdAt, @expiresAt, @maxAttempts)`,
    ).run(input);
    return this.find(input.id)!;
  }

  find(id: string): InvoiceShareChallengeRow | undefined {
    return this.db.prepare(
      "SELECT * FROM invoice_share_challenges WHERE id = ?",
    ).get(id) as InvoiceShareChallengeRow | undefined;
  }

  findLatestActiveForShare(shareId: string, now: number): InvoiceShareChallengeRow | undefined {
    return this.db.prepare(
      `SELECT * FROM invoice_share_challenges
       WHERE share_id = ? AND consumed_at IS NULL AND expires_at >= ?
         AND attempt_count < max_attempts
       ORDER BY created_at DESC LIMIT 1`,
    ).get(shareId, now) as InvoiceShareChallengeRow | undefined;
  }

  /** 失敗上限に達した行も含む発行総数。 再発行による試行回数の水増しを閉じるために使う。 */
  countForShare(shareId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS count FROM invoice_share_challenges WHERE share_id = ?",
    ).get(shareId) as { count: number }).count;
  }

  recordFailedAttempt(id: string, now: number): boolean {
    const result = this.db.prepare(
      `UPDATE invoice_share_challenges
       SET attempt_count = attempt_count + 1
       WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?
         AND attempt_count < max_attempts`,
    ).run(id, now);
    return result.changes > 0;
  }

  consume(id: string, now: number): boolean {
    const result = this.db.prepare(
      `UPDATE invoice_share_challenges
       SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?
         AND attempt_count < max_attempts`,
    ).run(now, id, now);
    return result.changes > 0;
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM invoice_share_challenges WHERE id = ? AND consumed_at IS NULL").run(id);
  }
}
