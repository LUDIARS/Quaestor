import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { normalizePayee } from "../shared/text.js";
import type { DocKind, SampleRole, SampleSource } from "../shared/document-kinds.js";
import type { KindFields } from "../shared/receipt-kind-fields.js";

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
  /** 書類種別 (v19)。 既定 'receipt' */
  doc_kind: DocKind;
  /** 種別固有フィールド (JSON)。 receipt / handwritten / other は NULL */
  kind_fields: string | null;
  /** LLM / 人手のサンプルラベル (v19)。 NULL = 未ラベル */
  sample_role: SampleRole | null;
  /** JSON 配列 */
  sample_tags: string | null;
  sample_reason: string | null;
  sample_source: SampleSource | null;
  /** JSON 配列 (内容タグ) */
  content_tags: string | null;
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

/**
 * 種別・サンプルラベルの更新。 undefined の項目は触らない (部分更新)。
 * sample_source は必ず指定する (誰が付けたラベルかを常に残す)。
 */
export interface UpdateLabelsInput {
  doc_kind?: DocKind;
  kind_fields?: KindFields | null;
  sample_role?: SampleRole | null;
  sample_tags?: string[] | null;
  sample_reason?: string | null;
  content_tags?: string[] | null;
  sample_source: SampleSource;
}

export interface ListFilter {
  status?: OcrStatus;
  date_from?: string;
  date_to?: string;
  doc_kind?: DocKind;
  sample_role?: SampleRole;
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
    const { whereSql, params } = buildWhere(filter);
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    return this.db
      .prepare(`SELECT * FROM receipts ${whereSql} ORDER BY captured_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as ReceiptRow[];
  }

  count(filter: ListFilter = {}): number {
    const { whereSql, params } = buildWhere(filter);
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM receipts ${whereSql}`).get(params) as { c: number };
    return r.c;
  }

  /**
   * サンプルラベル未付与 (sample_role IS NULL)、 かつ人手上書きでなく、 画像を持ち OCR が終わった receipt を
   * 撮影順 (古い順) に返す。 後付けラベル CLI の対象母集団 (spec SPEC-SCAN-KIND-004)。
   * pending / processing は OCR 完了時にラベルが付くので含めない。
   */
  listUnlabeled(limit: number = 1000): ReceiptRow[] {
    return this.db
      .prepare(
        `SELECT * FROM receipts
         WHERE sample_role IS NULL AND sample_source IS NOT 'manual' AND image_path IS NOT NULL
           AND ocr_status IN ('done','manual','failed')
         ORDER BY captured_at ASC, id ASC
         LIMIT ?`,
      )
      .all(limit) as ReceiptRow[];
  }

  countUnlabeled(): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM receipts
         WHERE sample_role IS NULL AND sample_source IS NOT 'manual' AND image_path IS NOT NULL
           AND ocr_status IN ('done','manual','failed')`,
      )
      .get() as { c: number };
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
   * metadata (JSON) に部分マージする。 撮影時 detect の運用評価レコードのように、
   * 既存の撮影 context (source / kind / image_hash) を消さずに 1 キーだけ足したい書き込みに使う。
   * 値 undefined のキーは無視、null は「そのキーを消す」。
   */
  mergeMetadata(id: string, patch: Record<string, unknown>): boolean {
    const row = this.find(id);
    if (!row) return false;
    let current: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch { /* 壊れた metadata は捨てて作り直す (観測用の付随情報) */ }
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) delete current[k];
      else current[k] = v;
    }
    const r = this.db
      .prepare(`UPDATE receipts SET metadata = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(current), nowSec(), id);
    return r.changes > 0;
  }

  /**
   * 種別・サンプルラベルを部分更新する。 誰が付けたか (sample_source) は毎回上書きする。
   * 「LLM を人手で上書きしてよいか」 の判断は services/receipt-labels.ts が持つ (ここは書くだけ)。
   */
  setLabels(id: string, input: UpdateLabelsInput): boolean {
    const sets: string[] = ["sample_source = @sample_source", "updated_at = @updated_at"];
    const params: Record<string, unknown> = {
      id,
      sample_source: input.sample_source,
      updated_at: nowSec(),
    };
    if (input.doc_kind !== undefined) { sets.push("doc_kind = @doc_kind"); params.doc_kind = input.doc_kind; }
    if (input.kind_fields !== undefined) {
      sets.push("kind_fields = @kind_fields");
      params.kind_fields = input.kind_fields ? JSON.stringify(input.kind_fields) : null;
    }
    if (input.sample_role !== undefined) { sets.push("sample_role = @sample_role"); params.sample_role = input.sample_role; }
    if (input.sample_tags !== undefined) {
      sets.push("sample_tags = @sample_tags");
      params.sample_tags = input.sample_tags ? JSON.stringify(input.sample_tags) : null;
    }
    if (input.sample_reason !== undefined) { sets.push("sample_reason = @sample_reason"); params.sample_reason = input.sample_reason; }
    if (input.content_tags !== undefined) {
      sets.push("content_tags = @content_tags");
      params.content_tags = input.content_tags ? JSON.stringify(input.content_tags) : null;
    }
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

function buildWhere(filter: ListFilter): { whereSql: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.status) { where.push("ocr_status = @status"); params.status = filter.status; }
  if (filter.date_from) { where.push("date >= @date_from"); params.date_from = filter.date_from; }
  if (filter.date_to) { where.push("date <= @date_to"); params.date_to = filter.date_to; }
  if (filter.doc_kind) { where.push("doc_kind = @doc_kind"); params.doc_kind = filter.doc_kind; }
  if (filter.sample_role) { where.push("sample_role = @sample_role"); params.sample_role = filter.sample_role; }
  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
