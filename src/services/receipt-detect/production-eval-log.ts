/**
 * 運用評価レコード (production-eval.jsonl) の読み書き。
 *
 * 撮影 1 枚 = 1 行。学習コーパス (夜間バッチの evolution.jsonl / bench-report.json) とは
 * 別系統で、「最適化済みの勝ち遺伝子が実運用でどれだけ当てたか」だけを残す。
 *
 *  - append: 1 行 1 レコードで追記 (同期で baseline が無ければ baselineFitness=null で発行)
 *  - setBaseline: 後追いで baseline を埋める (行を差し替えて atomic replace。行数は増やさない)
 *  - summary: 直近 n 件の平均。**判定はしない** (値をログ / B-5 のカードに出すだけ)
 *
 * @implements SPEC-OCR-GA-EVAL-006 (spec/feature/ocr-ga-evaluation.md)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { OcrGenome } from "../ocr-ga.js";
import type { ProductionEvalRecord, ProductionEvalSummary } from "./types.js";

export const PRODUCTION_EVAL_FILE = "production-eval.jsonl";
/** summary の既定サンプル数 (設計書 §3.1-4 の「直近 20 件」。閾値は仮置き) */
export const RECENT_EVAL_WINDOW = 20;

export class ProductionEvalLog {
  readonly file: string;

  constructor(root = "app_data/training/ga") {
    this.file = join(resolve(root), PRODUCTION_EVAL_FILE);
  }

  /** 1 行 1 レコードで追記する。ディレクトリは初回追記時にだけ作る */
  append(record: ProductionEvalRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
  }

  /** 追記順のまま全件返す。壊れた行は飛ばす (観測用ファイルなので読めるものだけ使う) */
  read(): ProductionEvalRecord[] {
    if (!existsSync(this.file)) return [];
    const out: ProductionEvalRecord[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const record = parseRecord(line);
      if (record) out.push(record);
    }
    return out;
  }

  /** 新しい順に limit 件 */
  recent(limit = RECENT_EVAL_WINDOW): ProductionEvalRecord[] {
    const all = this.read();
    return all.slice(Math.max(0, all.length - limit)).reverse();
  }

  /**
   * (receiptId, ts) のレコードに baseline を後追いで書く。
   * 一時ファイル → rename で置き換えるので、途中終了で jsonl を壊さない。
   * @returns 対象が見つかって書き換えたか
   */
  setBaseline(receiptId: string, ts: string, baselineFitness: number): boolean {
    if (!existsSync(this.file)) return false;
    const records = this.read();
    let patched = false;
    const next = records.map((r) => {
      if (patched || r.receiptId !== receiptId || r.ts !== ts) return r;
      patched = true;
      return { ...r, baselineFitness };
    });
    if (!patched) return false;
    writeAtomic(this.file, next.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return true;
  }

  /**
   * 直近 limit 件の平均。fitness / baseline の値を出すだけで、
   * bestGenome を default に戻す判定は **しない** (閾値は仮置き、人が B-5 のカードで見る)。
   */
  summary(limit = RECENT_EVAL_WINDOW): ProductionEvalSummary | null {
    const recent = this.recent(limit);
    if (recent.length === 0) return null;
    const baselines = recent.map((r) => r.baselineFitness).filter((v): v is number => v != null);
    const meanFitness = mean(recent.map((r) => r.fitness));
    const meanBaselineFitness = baselines.length > 0 ? mean(baselines) : null;
    return {
      count: recent.length,
      meanFitness,
      baselineSamples: baselines.length,
      meanBaselineFitness,
      belowBaseline: meanBaselineFitness == null ? null : meanFitness < meanBaselineFitness,
    };
  }
}

function parseRecord(line: string): ProductionEvalRecord | null {
  const t = line.trim();
  if (t.length === 0) return null;
  try {
    return parseProductionEvalRecord(JSON.parse(t));
  } catch {
    return null;
  }
}

/** JSONL / receipts.metadata 境界で運用評価レコードの全必須フィールドを検証する。 */
export function parseProductionEvalRecord(value: unknown): ProductionEvalRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<ProductionEvalRecord>;
  if (typeof record.receiptId !== "string" || record.receiptId.length === 0) return null;
  if (typeof record.label !== "string" || record.label.length === 0) return null;
  if (!Array.isArray(record.tags) || !record.tags.every((tag) => typeof tag === "string")) return null;
  if (typeof record.generation !== "number" || !Number.isInteger(record.generation) || record.generation < 0) return null;
  if (!isGenome(record.genome)) return null;
  if (!isScore(record.fitness)) return null;
  if (record.baselineFitness !== null && !isScore(record.baselineFitness)) return null;
  if (!record.fieldHits || typeof record.fieldHits.date !== "boolean"
    || typeof record.fieldHits.payee !== "boolean" || typeof record.fieldHits.total !== "boolean") return null;
  if (typeof record.elapsedMs !== "number" || !Number.isFinite(record.elapsedMs) || record.elapsedMs < 0) return null;
  if (typeof record.ts !== "string" || !Number.isFinite(Date.parse(record.ts))) return null;
  return record as ProductionEvalRecord;
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isGenome(value: unknown): value is OcrGenome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const genome = value as Partial<OcrGenome>;
  return typeof genome.detThresh === "number" && Number.isFinite(genome.detThresh)
    && typeof genome.boxThresh === "number" && Number.isFinite(genome.boxThresh)
    && typeof genome.unclipRatio === "number" && Number.isFinite(genome.unclipRatio)
    && [736, 960, 1280, 1600].includes(genome.limitSideLen ?? -1)
    && typeof genome.useDilation === "boolean"
    && typeof genome.dropScore === "number" && Number.isFinite(genome.dropScore);
}

function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, body, "utf8");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* failed atomic-write cleanup */ }
    }
  }
}

function mean(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 10_000) / 10_000;
}
