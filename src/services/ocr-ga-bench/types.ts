/**
 * OCR-GA ベンチマーク (ラベル別オフライン評価) の共有型。
 * spec/feature/ocr-ga-evaluation.md。
 */

import type { OcrGenome } from "../ocr-ga.js";
import type { OcrTruth } from "../ocr-ga-fitness.js";

/** コーパスの 1 レシート: 画像参照 + LLM 真値 (人の修正後) */
export interface BenchCorpusEntry {
  receiptId: string;
  /** ReceiptStorage 上の相対 path */
  imagePath: string;
  capturedAt: number;
  truth: OcrTruth;
}

/** ラベル (global / tag:<x>) ごとのコーパス (train / holdout 分割済) */
export interface LabelCorpus {
  label: string;
  train: BenchCorpusEntry[];
  holdout: BenchCorpusEntry[];
}

/** フィールド別 hit 率 (コーパス中で真値を復元できた割合、0..1) */
export interface FieldHitRate {
  date: number;
  payee: number;
  total: number;
}

/** 1 個体をコーパスで採点した結果 (fitness = コーパス平均) */
export interface GenomeScore {
  genome: OcrGenome;
  fitness: number;
  fieldHitRate: FieldHitRate;
  /** 画像 1 枚あたりの sidecar 所要 (成功分の平均、ms) */
  meanElapsedMs: number;
  /** この個体の評価に使った sidecar 所要の合計 (ms、キャッシュ分も計上) */
  totalElapsedMs: number;
  /** 採点したレシート数 */
  evaluated: number;
  /** 画像欠損 / sidecar 失敗で 0 点扱いにした数 */
  errors: number;
}

export interface ScoreSummary {
  fitness: number;
  fieldHitRate: FieldHitRate;
}

/** ラベル 1 つ分のベンチ結果 (bench-report.json の要素) */
export interface LabelBenchReport {
  label: string;
  corpus: { train: number; holdout: number; total: number };
  /** この run 後の世代番号 */
  generation: number;
  generationsRun: number;
  /** 1 世代で評価した個体数 */
  population: number;
  best: ScoreSummary & { genome: OcrGenome };
  mean: number;
  worst: number;
  /** 既定遺伝子を同じ train で採点した値 */
  baseline: ScoreSummary;
  /** holdout での best / baseline。holdout が空なら null */
  holdout: { best: ScoreSummary | null; baseline: ScoreSummary | null };
  /** 1 個体を train 全件で評価するのにかかった秒数 (平均) */
  secondsPerIndividual: number;
  /** このラベルの run 全体の秒数 */
  totalSeconds: number;
  /** 実際に sidecar を叩いた回数 (同じ遺伝子×画像はキャッシュ) */
  detectCalls: number;
  errors: number;
  /** 最終世代で再 seed ガードが発動したか */
  reseeded: boolean;
  ts: string;
}

export interface BenchReport {
  ts: string;
  sidecarUrl: string;
  /** sidecar /health が報告した device (cpu / gpu)。不明は null */
  device: string | null;
  labels: LabelBenchReport[];
}

/** pino 互換の最小ロガー (省略可) */
export interface BenchLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
}
