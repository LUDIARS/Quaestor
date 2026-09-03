/**
 * `GET /v1/ocr-ga/status` (設定ページ「OCR 進化」カード) の応答型。
 *
 * ベンチ内部の型 (types.ts) とは別に置く。こちらは **観測用の API 契約**で、
 * web (`web/src/components/ocr-evolution/types.ts`) が同じ形を写している。
 * 個人データ (店名 / 金額 / receiptId) は 1 つも含めない — 出すのは
 * 集計値 (fitness / hit 率 / 件数 / 秒数 / 時刻) だけ。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import type { FieldHitRate, ScoreSummary } from "./types.js";

/** `training.gaBench` の実効値 (AppConfig["training"]["gaBench"] と同形) */
export interface GaBenchSettings {
  enabled: boolean;
  hour: number;
  generationsPerNight: number;
  sidecarUrl: string | null;
  device: "cpu" | "gpu";
  costPerSecond: number;
}

/** sidecar `/health` の観測結果。不達でもエラーにせずここに理由を入れる */
export interface GaStatusSidecar {
  /** 実際に叩いた URL (gaBench.sidecarUrl ?? 運用 sidecar) */
  url: string;
  /** `/health` が応答したか */
  reachable: boolean;
  /** 応答が `ok:true` だったか (不達なら false) */
  ok: boolean;
  device: "cpu" | "gpu" | null;
  requestedDevice: string | null;
  /** gpu 要求が CPU に落ちた理由 */
  deviceError: string | null;
  /** 不達 / エラーの理由。到達して ok なら null */
  error: string | null;
}

/** evolution.jsonl の 1 世代分 (推移表示用。bestGenome は載せない) */
export interface GaGenerationPoint {
  ts: string;
  generation: number;
  /** その世代で採点した個体数 */
  evaluated: number;
  best: number | null;
  mean: number | null;
  baseline: number | null;
  /** 再 seed ガードが発動した世代 */
  reseeded: boolean;
}

/** bench-report.json の 1 ラベル分から、カードに出す値だけ写したもの (genome は載せない) */
export interface GaStatusBenchLabel {
  corpus: { train: number; holdout: number; total: number };
  generation: number;
  generationsRun: number;
  population: number;
  best: ScoreSummary;
  mean: number;
  worst: number;
  baseline: ScoreSummary;
  holdout: { best: ScoreSummary | null; baseline: ScoreSummary | null };
  /** 1 個体を train 全件で評価する秒数 (平均) */
  secondsPerIndividual: number;
  totalSeconds: number;
  detectCalls: number;
  errors: number;
  reseeded: boolean;
  /** このラベルを最後に評価した時刻 (ISO8601) */
  ts: string;
}

/** カードの 1 行 = 1 ラベル (global / tag:<形状タグ>) */
export interface GaStatusLabel {
  label: string;
  /** bench-report.json に載っていなければ null (evolution.jsonl にだけ居るラベル) */
  bench: GaStatusBenchLabel | null;
  /** evolution.jsonl の直近 N 世代 (古い順)。1 世代も無ければ空配列 */
  trend: GaGenerationPoint[];
}

/** 直近 N 件の運用評価まとめ。レコードが 1 件も無ければ status から **キーごと落とす** */
export interface GaStatusProduction {
  /** 集計に使った件数 */
  count: number;
  /** 集計窓 (直近 N 件) */
  window: number;
  meanFitness: number;
  /** baselineFitness が埋まっている件数 */
  baselineSamples: number;
  /** baseline が 1 件も埋まっていなければ null */
  meanBaselineFitness: number | null;
  /** meanFitness − meanBaselineFitness。baseline が無ければ null (判定はしない) */
  baselineDelta: number | null;
  /** フィールドごとの hit 率 (0..1) */
  meanFieldHits: FieldHitRate;
  /** 集計に入れた最新レコードの時刻 (ISO8601) */
  latestTs: string;
}

export type GaStatusWarningCode =
  | "bench_report_missing"
  | "sidecar_unreachable"
  | "no_evaluations"
  | "stale_evaluation";

export interface GaStatusWarning {
  code: GaStatusWarningCode;
  /** 画面にそのまま出す日本語 1 文 */
  message: string;
}

/** `GET /v1/ocr-ga/status` の応答 */
export interface OcrGaStatus {
  /** この応答を作った時刻 (ISO8601) */
  ts: string;
  /** quaestor.config.json + env override の実効値。反映は再起動後 */
  config: GaBenchSettings;
  sidecar: GaStatusSidecar;
  /** bench-report.json 全体のヘッダ。ファイルが無ければ null */
  bench: { ts: string; sidecarUrl: string; device: string | null } | null;
  labels: GaStatusLabel[];
  /** production-eval.jsonl が空 / 無ければ **このキー自体が無い** */
  production?: GaStatusProduction;
  warnings: GaStatusWarning[];
}
