import type Database from "better-sqlite3";

export type MailKind = "invoice" | "cloud_notice" | "ignore";
export interface MailMessageRow {
  message_id: string;
  thread_id: string | null;
  received_at: number;
  from_address: string;
  subject: string;
  kind: MailKind;
  rule_index: number | null;
  outcome: string;
  error: string | null;
  processed_at: number;
}

export class MailMessagesRepo {
  /** @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md) */
  constructor(private readonly db: Database.Database) {}

  /** @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md) */
  find(id: string): MailMessageRow | undefined {
    return this.db.prepare("SELECT * FROM mail_messages WHERE message_id = ?").get(id) as
      MailMessageRow | undefined;
  }

  /** Atomically reserves a message so concurrent sweeps cannot process it twice. */
  /** @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md) */
  claim(row: MailMessageRow): boolean {
    return this.db.prepare(
      `INSERT OR IGNORE INTO mail_messages
       (message_id, thread_id, received_at, from_address, subject, kind, rule_index, outcome, error, processed_at)
       VALUES (@message_id, @thread_id, @received_at, @from_address, @subject, @kind, @rule_index, @outcome, @error, @processed_at)`,
    ).run(row).changes > 0;
  }

  /** @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md) */
  updateOutcome(messageId: string, outcome: string, error: string | null): boolean {
    return this.db.prepare(
      "UPDATE mail_messages SET outcome = ?, error = ?, processed_at = ? WHERE message_id = ?",
    ).run(outcome, error, nowSec(), messageId).changes > 0;
  }

  /** @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md) */
  list(kind?: MailKind, limit = 50): MailMessageRow[] {
    return (kind
      ? this.db.prepare(
        "SELECT * FROM mail_messages WHERE kind = ? ORDER BY received_at DESC LIMIT ?",
      ).all(kind, limit)
      : this.db.prepare(
        "SELECT * FROM mail_messages ORDER BY received_at DESC LIMIT ?",
      ).all(limit)) as MailMessageRow[];
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
