/**
 * ベンチマークコーパスの構築: receipts (OCR 済 + 画像あり) から真値とラベルを作る。
 *
 * 真値は receipts の date / payee / total / items (LLM 出力 + 人が投入時に直した値)。
 * ラベルは D1 (書類種別 + サンプルラベル) が receipts に足す列で決める:
 *   sample_role = good_sample   → `global`
 *   sample_role = special_shape → `tag:<x>` (sample_tags の各タグ)、有効タグが無ければ global
 *   sample_role = none          → 学習に使わない
 *   未ラベル (NULL) / 不明値      → global (後付けラベルが済むまでのつなぎ)
 * 列そのものが無い DB (D1 未マージ) では PRAGMA で検知し全件を global として扱う。
 * 件数が MIN_LABEL_CORPUS 未満のタグは集団を作らず、そのレシートを global に含める。
 *
 * DB は読むだけ (本番 DB を read-only で開いても動く)。
 *
 * @implements SPEC-OCR-GA-EVAL-001 (spec/feature/ocr-ga-evaluation.md)
 */

import type Database from "better-sqlite3";
import { GA_GLOBAL_KEY, MIN_LABEL_CORPUS, tagGaKey } from "../ocr-ga.js";
import { DEFAULT_HOLDOUT_RATIO, splitHoldout } from "./corpus-split.js";
import type { BenchCorpusEntry, LabelCorpus } from "./types.js";

export interface SampleColumns {
  role: boolean;
  tags: boolean;
}

export interface CorpusRow {
  id: string;
  image_path: string;
  captured_at: number;
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;
  sample_role: string | null;
  sample_tags: string | null;
}

export interface BuildCorpusOptions {
  /** ラベルごとの上限件数 (新しい順)。未指定は全件 */
  limit?: number;
  /** ラベル別集団を作る最小件数。既定 MIN_LABEL_CORPUS */
  minLabelCorpus?: number;
  holdoutRatio?: number;
}

/** receipts に D1 のサンプルラベル列があるか (無い DB でも動かすための検知) */
export function detectSampleColumns(db: Database.Database): SampleColumns {
  const cols = (db.prepare("PRAGMA table_info(receipts)").all() as Array<{ name: string }>).map((c) => c.name);
  return { role: cols.includes("sample_role"), tags: cols.includes("sample_tags") };
}

/** 真値と画像を持つレシートを新しい順に読む。列が無ければ NULL で埋める */
export function loadCorpusRows(db: Database.Database, cols: SampleColumns): CorpusRow[] {
  const roleCol = cols.role ? "sample_role" : "NULL AS sample_role";
  const tagsCol = cols.tags ? "sample_tags" : "NULL AS sample_tags";
  return db
    .prepare(
      `SELECT id, image_path, captured_at, date, payee, total, items, ${roleCol}, ${tagsCol}
       FROM receipts
       WHERE ocr_status IN ('done', 'manual') AND image_path IS NOT NULL
       ORDER BY captured_at DESC, id`,
    )
    .all() as CorpusRow[];
}

/** sample_tags (JSON 配列 or カンマ/空白区切り) → 生タグ列 */
export function parseSampleTags(raw: string | null | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return []; // 壊れた JSON はタグ無し = global 扱い
    }
  }
  return t.split(/[,\s]+/).filter((s) => s.length > 0);
}

/** row の所属ラベル。null = 学習に使わない (sample_role = none) */
export function labelsForRow(row: Pick<CorpusRow, "sample_role" | "sample_tags">, cols: SampleColumns): string[] | null {
  if (!cols.role) return [GA_GLOBAL_KEY];
  const role = (row.sample_role ?? "").trim();
  if (role === "none") return null;
  if (role !== "special_shape") return [GA_GLOBAL_KEY];
  const keys = parseSampleTags(cols.tags ? row.sample_tags : null)
    .map(tagGaKey)
    .filter((k): k is string => k !== null);
  return keys.length > 0 ? [...new Set(keys)] : [GA_GLOBAL_KEY];
}

export function buildBenchCorpus(db: Database.Database, opts: BuildCorpusOptions = {}): LabelCorpus[] {
  const cols = detectSampleColumns(db);
  const rows = loadCorpusRows(db, cols);
  const minLabel = opts.minLabelCorpus ?? MIN_LABEL_CORPUS;

  // 1) ラベルごとに振り分け (1 レシートが複数タグに入ることはある)
  const byLabel = new Map<string, BenchCorpusEntry[]>();
  for (const row of rows) {
    const labels = labelsForRow(row, cols);
    if (!labels) continue;
    const entry = toEntry(row);
    for (const label of labels) {
      const bucket = byLabel.get(label);
      if (bucket) bucket.push(entry);
      else byLabel.set(label, [entry]);
    }
  }

  // 2) 件数不足のタグは集団を作らず global に畳む (重複は receiptId で除く)
  const global = byLabel.get(GA_GLOBAL_KEY) ?? [];
  byLabel.set(GA_GLOBAL_KEY, global);
  const globalIds = new Set(global.map((e) => e.receiptId));
  for (const [label, entries] of [...byLabel.entries()]) {
    if (label === GA_GLOBAL_KEY || entries.length >= minLabel) continue;
    byLabel.delete(label);
    for (const e of entries) {
      if (globalIds.has(e.receiptId)) continue;
      global.push(e);
      globalIds.add(e.receiptId);
    }
  }

  // 3) 新しい順を保って limit → 決定的 split
  const out: LabelCorpus[] = [];
  for (const [label, entries] of byLabel.entries()) {
    const sorted = [...entries].sort((a, b) => b.capturedAt - a.capturedAt || a.receiptId.localeCompare(b.receiptId));
    const limited = opts.limit != null ? sorted.slice(0, Math.max(0, opts.limit)) : sorted;
    const { train, holdout } = splitHoldout(limited, opts.holdoutRatio ?? DEFAULT_HOLDOUT_RATIO);
    out.push({ label, train, holdout });
  }
  return out.sort(compareLabels);
}

function toEntry(row: CorpusRow): BenchCorpusEntry {
  return {
    receiptId: row.id,
    imagePath: row.image_path,
    capturedAt: row.captured_at,
    truth: { date: row.date, payee: row.payee, total: row.total, items: row.items },
  };
}

/** global を先頭、残りはタグ名順 */
function compareLabels(a: LabelCorpus, b: LabelCorpus): number {
  if (a.label === GA_GLOBAL_KEY) return -1;
  if (b.label === GA_GLOBAL_KEY) return 1;
  return a.label.localeCompare(b.label);
}
