import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type InboundDocumentStatus = "pending" | "committed" | "needs_review" | "ignored";
export interface InboundDocumentRow {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string;
  file_path: string;
  sha256: string;
  size: number;
  extracted: string | null;
  status: InboundDocumentStatus;
  receipt_id: string | null;
  created_at: number;
  updated_at: number;
}

export class InboundDocumentsRepo {
  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  constructor(private readonly db: Database.Database) {}

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  find(id: string): InboundDocumentRow | undefined {
    return this.db.prepare("SELECT * FROM inbound_documents WHERE id = ?").get(id) as
      InboundDocumentRow | undefined;
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  findByHash(hash: string): InboundDocumentRow | undefined {
    return this.db.prepare("SELECT * FROM inbound_documents WHERE sha256 = ?").get(hash) as
      InboundDocumentRow | undefined;
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  list(status?: InboundDocumentStatus): InboundDocumentRow[] {
    return (status
      ? this.db.prepare(
        "SELECT * FROM inbound_documents WHERE status = ? ORDER BY created_at DESC",
      ).all(status)
      : this.db.prepare(
        "SELECT * FROM inbound_documents ORDER BY created_at DESC",
      ).all()) as InboundDocumentRow[];
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  insert(
    input: Omit<InboundDocumentRow, "id" | "created_at" | "updated_at" | "receipt_id">
      & { id?: string; receipt_id?: string | null },
  ): string {
    const now = nowSec();
    const id = input.id ?? randomUUID();
    this.db.prepare(
      `INSERT INTO inbound_documents
       (id, message_id, filename, mime_type, file_path, sha256, size, extracted, status, receipt_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.message_id,
      input.filename,
      input.mime_type,
      input.file_path,
      input.sha256,
      input.size,
      input.extracted,
      input.status,
      input.receipt_id ?? null,
      now,
      now,
    );
    return id;
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  update(id: string, status: InboundDocumentStatus, receiptId?: string): boolean {
    return this.db.prepare(
      `UPDATE inbound_documents
       SET status = ?, receipt_id = COALESCE(?, receipt_id), updated_at = ?
       WHERE id = ?`,
    ).run(status, receiptId ?? null, nowSec(), id).changes > 0;
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  claimForCommit(id: string): InboundDocumentRow | undefined {
    const claimed = this.db.prepare(
      "UPDATE inbound_documents SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'needs_review'",
    ).run(nowSec(), id).changes > 0;
    return claimed ? this.find(id) : undefined;
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  ignore(id: string): boolean {
    return this.db.prepare(
      `UPDATE inbound_documents SET status = 'ignored', updated_at = ?
       WHERE id = ? AND status = 'needs_review'`,
    ).run(nowSec(), id).changes > 0;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
