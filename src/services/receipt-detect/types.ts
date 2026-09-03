/**
 * 撮影時 detect (backend) の共有型。
 *
 * 「勝ち遺伝子で 1 回だけ sidecar を叩き、その結果を LLM 真値で採点して運用評価レコードを
 * 1 件発行する」経路の入出力だけを置く (判断もファイル I/O もここには無い)。
 *
 * @implements SPEC-OCR-GA-EVAL-006 (spec/feature/ocr-ga-evaluation.md)
 */

import type { OcrGenome } from "../ocr-ga.js";

/**
 * 検出した本物 BB (source=real 相当)。座標は画像ピクセル (naturalWidth/Height 座標系)。
 * 色やラベル文言は演出側 (web) の関心なので持たない — field が学習ラベルであり id である。
 */
export interface DetectedFieldRegion {
  /** フィールド種別 (payee / date / total / item-<n>)。学習レコードの label になる */
  field: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** sidecar の認識スコア (0..1) */
  confidence: number;
  /** OCR が読んだ生テキスト */
  recognizedText: string;
  /** 回転レシート用の 4 点ポリゴン */
  polygon: Array<[number, number]>;
}

/** 撮影 1 枚に対する運用評価レコード (production-eval.jsonl の 1 行 = これ 1 件) */
export interface ProductionEvalRecord {
  receiptId: string;
  /** 採用した集団キー (global / tag:<形状タグ>) */
  label: string;
  /** 遺伝子解決に使った LLM のサンプルタグ */
  tags: string[];
  /** 採用した best を記録した世代 (既定遺伝子は 0) */
  generation: number;
  genome: OcrGenome;
  fitness: number;
  fieldHits: { date: boolean; payee: boolean; total: boolean };
  /** 既定遺伝子で同じ画像を採点した値。同期で間に合わなければ null で発行し後追いで埋める */
  baselineFitness: number | null;
  /** sidecar /detect の所要時間 (ms) */
  elapsedMs: number;
  /** ISO8601 (evolution.jsonl と同じ形式)。receiptId と組で 1 レコードを特定する */
  ts: string;
}

/** 直近 n 件の運用評価まとめ (判定は自動化せず、値をログに出すだけ) */
export interface ProductionEvalSummary {
  /** 集計に使った件数 */
  count: number;
  meanFitness: number;
  /** baselineFitness が埋まっている件数 */
  baselineSamples: number;
  /** baseline が 1 件も埋まっていなければ null */
  meanBaselineFitness: number | null;
  /** meanFitness < meanBaselineFitness。baseline 未取得なら null (判定はしない) */
  belowBaseline: boolean | null;
}

/** detect が本物 BB を出せなかった理由 (呼び出し側の演出は fallback に落ちる) */
export type DetectSkipReason =
  | "ocr_not_ready"
  | "image_missing"
  | "sidecar_failed"
  | "no_lines"
  | "no_truth"
  | "input_changed"
  | "detect_disabled";

/** POST /v1/receipts/:id/detect の結果 */
export interface ReceiptDetectOutcome {
  receiptId: string;
  /** 本物 BB を返せたときだけ "real"。出せなければ null (200 で空結果) */
  source: "real" | null;
  /** source が null のときの理由 */
  reason: DetectSkipReason | null;
  /** 既に評価済で sidecar を叩かずに返したか */
  cached: boolean;
  /** 採用した集団キー */
  key: string;
  /** 遺伝子の出所 (tag → global → default) */
  genomeSource: "tag" | "global" | "default";
  generation: number;
  genome: OcrGenome;
  naturalWidth: number;
  naturalHeight: number;
  regions: DetectedFieldRegion[];
  elapsedMs: number;
  /** 採点できなかったときは null */
  eval: ProductionEvalRecord | null;
}

/** 秘密・個人データを含めずに観測するための logger (app.ts の AppLogger と同形) */
export interface DetectLogger {
  info?(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}
