/**
 * `GET /v1/ocr-ga/status` の応答型 (backend `src/services/ocr-ga-bench/status-types.ts` の写し)。
 *
 * backend 側が正本。ここを変えるときは向こうも合わせる。
 * 個人データ (店名 / 金額) は応答に含まれない — 集計値だけを描く。
 */

export interface FieldHitRate {
  date: number;
  payee: number;
  total: number;
}

export interface ScoreSummary {
  fitness: number;
  fieldHitRate: FieldHitRate;
}

export interface GaBenchSettings {
  enabled: boolean;
  hour: number;
  generationsPerNight: number;
  sidecarUrl: string | null;
  device: "cpu" | "gpu";
  costPerSecond: number;
}

export interface GaStatusSidecar {
  url: string;
  reachable: boolean;
  ok: boolean;
  device: "cpu" | "gpu" | null;
  requestedDevice: string | null;
  deviceError: string | null;
  error: string | null;
}

export interface GaGenerationPoint {
  ts: string;
  generation: number;
  evaluated: number;
  best: number | null;
  mean: number | null;
  baseline: number | null;
  reseeded: boolean;
}

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
  secondsPerIndividual: number;
  totalSeconds: number;
  detectCalls: number;
  errors: number;
  reseeded: boolean;
  ts: string;
}

export interface GaStatusLabel {
  label: string;
  bench: GaStatusBenchLabel | null;
  trend: GaGenerationPoint[];
}

export interface GaStatusProduction {
  count: number;
  window: number;
  meanFitness: number;
  baselineSamples: number;
  meanBaselineFitness: number | null;
  baselineDelta: number | null;
  meanFieldHits: FieldHitRate;
  latestTs: string;
}

export type GaStatusWarningCode =
  | "bench_report_missing"
  | "sidecar_unreachable"
  | "no_evaluations"
  | "stale_evaluation";

export interface GaStatusWarning {
  code: GaStatusWarningCode;
  message: string;
}

export interface OcrGaStatus {
  ts: string;
  config: GaBenchSettings;
  sidecar: GaStatusSidecar;
  bench: { ts: string; sidecarUrl: string; device: string | null } | null;
  labels: GaStatusLabel[];
  /** production-eval.jsonl が空 / 無ければキーごと来ない */
  production?: GaStatusProduction;
  warnings: GaStatusWarning[];
}
