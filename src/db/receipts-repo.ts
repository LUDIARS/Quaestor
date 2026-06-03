import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { normalizePayee } from "../shared/text.js";

export type OcrStatus = "pending" | "processing" | "done" | "failed" | "manual";

export interface ReceiptRow {
  id: string;
  captured_at: number;
  image_path: string | null;
  ocr_status: OcrStatus;
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;
  geo: string | null;
  ocr_raw: string | null;
  metadata: string | null;
  /** 「投入」 済タイムスタンプ (unix sec)。 NULL = 未投入 (撮影 + OCR 待ち / 要編集) */
  committed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ReceiptItem {
  name: string;
  price: number;
  qty?: number;
}

export interface CreateReceiptInput {
  id?: string;
  captured_at?: number;            // unix sec、 既定は now
  image_path?: string | null;
  geo?: { lat: number; lon: number; accuracy?: number } | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateOcrInput {
  ocr_status: OcrStatus;
  date?: string | null;
  payee?: string | null;
  total?: number | null;
  items?: ReceiptItem[] | null;
  ocr_raw?: string | null;
}

export interface ListFilter {
  status?: OcrStatus;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export class ReceiptsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateReceiptInput): string {
    const id = input.id ?? randomUUID();
    const now = nowSec();
    this.db
      .prepare(
        `INSERT INTO receipts
         (id, captured_at, image_path, ocr_status, geo, metadata, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.captured_at ?? now,
        input.image_path ?? null,
        input.geo ? JSON.stringify(input.geo) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      );
    return id;
  }

  setImagePath(id: string, relativePath: string): boolean {
    const r = this.db
      .prepare(`UPDATE receipts SET image_path = ?, updated_at = ? WHERE id = ?`)
      .run(relativePath, nowSec(), id);
    return r.changes > 0;
  }

  /**
   * 直近 windowSec 秒以内に同じ image_hash を持つ receipt を返す。
   * Scanner の投機的実行で同じフレームを連続送信した場合の dedup 用。
   */
  findRecentByImageHash(imageHash: string, windowSec: number = 30): ReceiptRow | undefined {
    const cutoff = nowSec() - windowSec;
    return this.db
      .prepare(
        `SELECT * FROM receipts
         WHERE captured_at >= ?
           AND json_extract(metadata, '$.image_hash') = ?
         ORDER BY captured_at DESC
         LIMIT 1`,
      )
      .get(cutoff, imageHash) as ReceiptRow | undefined;
  }

  find(id: string): ReceiptRow | undefined {
    return this.db.prepare(`SELECT * FROM receipts WHERE id = ?`).get(id) as ReceiptRow | undefined;
  }

  list(filter: ListFilter = {}): ReceiptRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) { where.push("ocr_status = @status"); params.status = filter.status; }
    if (filter.date_from) { where.push("date >= @date_from"); params.date_from = filter.date_from; }
    if (filter.date_to) { where.push("date <= @date_to"); params.date_to = filter.date_to; }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    return this.db
      .prepare(`SELECT * FROM receipts ${whereSql} ORDER BY captured_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as ReceiptRow[];
  }

  count(filter: ListFilter = {}): number {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) { where.push("ocr_status = @status"); params.status = filter.status; }
    if (filter.date_from) { where.push("date >= @date_from"); params.date_from = filter.date_from; }
    if (filter.date_to) { where.push("date <= @date_to"); params.date_to = filter.date_to; }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM receipts ${whereSql}`).get(params) as { c: number };
    return r.c;
  }

  setOcrResult(id: string, input: UpdateOcrInput): boolean {
    const sets: string[] = ["ocr_status = @ocr_status", "updated_at = @updated_at"];
    const params: Record<string, unknown> = {
      id,
      ocr_status: input.ocr_status,
      updated_at: nowSec(),
    };
    if (input.date !== undefined) { sets.push("date = @date"); params.date = input.date; }
    if (input.payee !== undefined) { sets.push("payee = @payee"); params.payee = input.payee; }
    if (input.total !== undefined) { sets.push("total = @total"); params.total = input.total; }
    if (input.items !== undefined) {
      sets.push("items = @items");
      params.items = input.items ? JSON.stringify(input.items) : null;
    }
    if (input.ocr_raw !== undefined) { sets.push("ocr_raw = @ocr_raw"); params.ocr_raw = input.ocr_raw; }
    const r = this.db.prepare(`UPDATE receipts SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return r.changes > 0;
  }

  /**
   * 投入済 (committed_at IS NOT NULL) の中から、 同じ (日付-場所-金額) を持つ
   * receipt を返す。 ユニーク判定の正本。 payee は表記揺れに強いよう正規化比較する。
   * date + total で SQL 絞り込み → payee を JS で正規化突合 (投入済は少数前提)。
   *
   * @param excludeId 自分自身を除外したい時の id (再投入チェック用)
   */
  findCommittedDuplicate(
    date: string,
    payee: string,
    total: number,
    excludeId?: string,
  ): ReceiptRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM receipts
         WHERE committed_at IS NOT NULL AND date = ? AND total = ?`,
      )
      .all(date, total) as ReceiptRow[];
    const target = normalizePayee(payee);
    return rows.find((r) => r.id !== excludeId && normalizePayee(r.payee) === target);
  }

  /** receipt を投入済にする (committed_at をセット)。 既に投入済なら false。 */
  commit(id: string): boolean {
    const now = nowSec();
    const r = this.db
      .prepare(
        `UPDATE receipts SET committed_at = ?, updated_at = ?
         WHERE id = ? AND committed_at IS NULL`,
      )
      .run(now, now, id);
    return r.changes > 0;
  }

  delete(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM receipts WHERE id = ?`).run(id);
    return r.changes > 0;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
