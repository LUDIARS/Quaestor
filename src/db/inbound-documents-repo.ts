/**
 * 受領書類 (inbound_documents) の台帳。 メール添付 PDF (source='mail') と、
 * スキャンして `invoice` と分類された画像 (source='scan') の両方を持つ。
 *
 * @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md)
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type InboundDocumentStatus = "pending" | "committed" | "needs_review" | "ignored";
/** 受領経路。 mail = メール添付、 scan = 撮影して invoice と分類されたもの */
export type InboundDocumentSource = "mail" | "scan";

export interface InboundDocumentRow {
  id: string;
  source: InboundDocumentSource;
  /** mail のときは添付元メール。 scan は NULL */
  message_id: string | null;
  filename: string;
  mime_type: string;
  file_path: string;
  /** 添付の重複判定用。 scan は receipt 側の重複キーで判定するので NULL */
  sha256: string | null;
  size: number;
  extracted: string | null;
  status: InboundDocumentStatus;
  receipt_id: string | null;
  created_at: number;
  updated_at: number;
}

type InboundDocumentInsertBase = Omit<
  InboundDocumentRow,
  "id" | "created_at" | "updated_at" | "receipt_id" | "source" | "message_id" | "sha256"
> & { id?: string; receipt_id?: string | null };

export type InboundDocumentInsert = InboundDocumentInsertBase & (
  | { source?: "mail"; message_id: string; sha256: string }
  | { source: "scan"; message_id?: null; sha256?: null; receipt_id: string }
);

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
  findByReceipt(receiptId: string): InboundDocumentRow | undefined {
    return this.db.prepare("SELECT * FROM inbound_documents WHERE receipt_id = ?").get(receiptId) as
      InboundDocumentRow | undefined;
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  insert(input: InboundDocumentInsert): string {
    const now = nowSec();
    const id = input.id ?? randomUUID();
    const source = input.source ?? "mail";
    if (source === "mail" && (!input.message_id || !input.sha256)) {
      throw new Error("mail inbound documents require message_id and sha256");
    }
    if (source === "scan" && (input.message_id != null || input.sha256 != null || !input.receipt_id)) {
      throw new Error("scan inbound documents require receipt_id and must not set message_id or sha256");
    }
    this.db.prepare(
      `INSERT INTO inbound_documents
       (id, source, message_id, filename, mime_type, file_path, sha256, size, extracted, status, receipt_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      source,
      input.message_id ?? null,
      input.filename,
      input.mime_type,
      input.file_path,
      input.sha256 ?? null,
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
