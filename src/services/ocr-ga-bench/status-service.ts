/**
 * 「OCR 進化」カードに出す観測値を 1 つにまとめる (読み取りのみ)。
 *
 *   bench-report.json (今どうか) + evolution.jsonl (世代推移) + sidecar /health (生死)
 *   + training.gaBench (設定) + production-eval.jsonl (実運用、あれば)
 *
 * 世代を進めたり設定を書いたりはしない。sidecar が不達でも例外にせず、
 * 「不達である」ことを値として返す — 死んでいることが見えるのが目的だから。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import { join, resolve } from "node:path";
import type { OcrSidecarClient } from "../ocr-sidecar-client.js";
import { ProductionEvalLog, RECENT_EVAL_WINDOW } from "../receipt-detect/production-eval-log.js";
import type { ProductionEvalRecord } from "../receipt-detect/types.js";
import { DEFAULT_TREND_GENERATIONS, EVOLUTION_LOG_FILE, readEvolutionTrends } from "./evolution-log.js";
import { BENCH_REPORT_FILE, readBenchReport } from "./report.js";
import { isReadableBenchLabel } from "./status-report-validation.js";
import { computeGaStatusWarnings } from "./status-warnings.js";
import type {
  GaBenchSettings, GaGenerationPoint, GaStatusLabel, GaStatusProduction, GaStatusSidecar, OcrGaStatus,
} from "./status-types.js";
import type { LabelBenchReport } from "./types.js";

export interface OcrGaStatusDeps {
  /** GA 永続ルート (集団 / evolution.jsonl / bench-report.json / production-eval.jsonl) */
  gaRoot: string;
  /** training.gaBench の実効値 (env override 込み)。反映は再起動後 */
  gaBench: GaBenchSettings;
  /** `/health` を叩く sidecar。到達不能でもここでは投げさせない */
  sidecar: Pick<OcrSidecarClient, "baseUrl" | "health">;
  /** テスト用: 現在時刻 */
  now?: () => number;
  /** 推移として返す世代数 (既定 20) */
  trendLimit?: number;
  /** 運用評価の集計窓 (既定 20 件) */
  productionWindow?: number;
  /** 最終評価をこれより古いと「止まっている」とする (既定 48 時間) */
  staleAfterMs?: number;
}

export async function readOcrGaStatus(deps: OcrGaStatusDeps): Promise<OcrGaStatus> {
  const gaRoot = resolve(deps.gaRoot);
  const now = (deps.now ?? Date.now)();

  const report = readBenchReport(join(gaRoot, BENCH_REPORT_FILE));
  const readableLabels = (report?.labels ?? []).filter(isReadableBenchLabel);
  const trends = readEvolutionTrends(join(gaRoot, EVOLUTION_LOG_FILE), deps.trendLimit ?? DEFAULT_TREND_GENERATIONS);
  const sidecar = await probeSidecar(deps.sidecar);
  const production = summarizeProductionEval(
    new ProductionEvalLog(gaRoot).recent(deps.productionWindow ?? RECENT_EVAL_WINDOW),
    deps.productionWindow ?? RECENT_EVAL_WINDOW,
  );

  const status: OcrGaStatus = {
    ts: new Date(now).toISOString(),
    config: projectGaBenchSettings(deps.gaBench),
    sidecar,
    bench: report ? { ts: report.ts, sidecarUrl: publicUrl(report.sidecarUrl), device: report.device } : null,
    labels: mergeLabels(readableLabels, trends),
    warnings: computeGaStatusWarnings({
      now,
      benchReportPresent: report !== null,
      benchReportTs: report?.ts ?? null,
      evaluatedLabels: readableLabels.filter((label) => label.corpus.total > 0).length,
      sidecarHealthy: sidecar.reachable && sidecar.ok,
      sidecarDetail: sidecar.error,
      staleAfterMs: deps.staleAfterMs,
    }),
  };
  // 1 件も無いときはダミー値ではなく **キーごと落とす** (0 埋めは「測った結果 0」と区別できない)
  if (production) status.production = production;
  return status;
}

/** `/health` の到達可否を値にする。不達は理由を残して reachable:false (例外にしない) */
async function probeSidecar(client: Pick<OcrSidecarClient, "baseUrl" | "health">): Promise<GaStatusSidecar> {
  try {
    const health = await client.health();
    return {
      url: publicUrl(client.baseUrl),
      reachable: true,
      ok: health.ok,
      device: health.device,
      requestedDevice: health.requestedDevice,
      deviceError: health.deviceError,
      error: health.ok ? null : "sidecar reports ok=false",
    };
  } catch {
    // fetch/OS の生メッセージには private endpoint やローカルパスが混ざり得るため外へ出さない。
    return {
      url: publicUrl(client.baseUrl),
      reachable: false,
      ok: false,
      device: null,
      requestedDevice: null,
      deviceError: null,
      error: "sidecar health request failed",
    };
  }
}

/**
 * bench-report のラベルと evolution.jsonl のキーを突き合わせる。
 * どちらか片方にしか無いラベルも落とさない (report 前の世代 / 今回走らせなかったラベル)。
 */
function mergeLabels(reportLabels: LabelBenchReport[], trends: Map<string, GaGenerationPoint[]>): GaStatusLabel[] {
  const labels = new Set<string>([...reportLabels.map((label) => label.label), ...trends.keys()]);
  const byLabel = new Map(reportLabels.map((label) => [label.label, label]));
  return [...labels].sort((a, b) => a.localeCompare(b)).map((label) => ({
    label,
    bench: toBenchLabel(byLabel.get(label)),
    trend: trends.get(label) ?? [],
  }));
}

/** bench-report の 1 ラベルから、カードに出す値だけ写す (best.genome は載せない) */
function toBenchLabel(label: LabelBenchReport | undefined): GaStatusLabel["bench"] {
  if (!label) return null;
  return {
    corpus: {
      train: label.corpus.train,
      holdout: label.corpus.holdout,
      total: label.corpus.total,
    },
    generation: label.generation,
    generationsRun: label.generationsRun,
    population: label.population,
    best: projectScoreSummary(label.best),
    mean: label.mean,
    worst: label.worst,
    baseline: projectScoreSummary(label.baseline),
    holdout: {
      best: label.holdout.best ? projectScoreSummary(label.holdout.best) : null,
      baseline: label.holdout.baseline ? projectScoreSummary(label.holdout.baseline) : null,
    },
    secondsPerIndividual: label.secondsPerIndividual,
    totalSeconds: label.totalSeconds,
    detectCalls: label.detectCalls,
    errors: label.errors,
    reseeded: label.reseeded,
    ts: label.ts,
  };
}

function projectScoreSummary(summary: LabelBenchReport["baseline"]): LabelBenchReport["baseline"] {
  return {
    fitness: summary.fitness,
    fieldHitRate: {
      date: summary.fieldHitRate.date,
      payee: summary.fieldHitRate.payee,
      total: summary.fieldHitRate.total,
    },
  };
}

function projectGaBenchSettings(settings: GaBenchSettings): GaBenchSettings {
  return {
    enabled: settings.enabled,
    hour: settings.hour,
    generationsPerNight: settings.generationsPerNight,
    sidecarUrl: settings.sidecarUrl === null ? null : publicUrl(settings.sidecarUrl),
    device: settings.device,
    costPerSecond: settings.costPerSecond,
  };
}

/** 応答へ URL credential を出さない。不正値もローカル設定文字列のまま反射しない。 */
function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[invalid URL]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "[invalid URL]";
  }
}

/**
 * 直近 n 件の平均。**値を出すだけ**で、baseline を下回っていても遺伝子を戻す判定はしない
 * (閾値は仮置き、人がカードで見る。SPEC-OCR-GA-EVAL-006 と同じ立場)。
 */
function summarizeProductionEval(recent: ProductionEvalRecord[], window: number): GaStatusProduction | null {
  if (recent.length === 0) return null;
  const baselines = recent.map((r) => r.baselineFitness).filter((v): v is number => v != null);
  const meanFitness = mean(recent.map((r) => r.fitness));
  const meanBaselineFitness = baselines.length > 0 ? mean(baselines) : null;
  return {
    count: recent.length,
    window,
    meanFitness,
    baselineSamples: baselines.length,
    meanBaselineFitness,
    baselineDelta: meanBaselineFitness == null ? null : round4(meanFitness - meanBaselineFitness),
    meanFieldHits: {
      date: mean(recent.map((r) => (r.fieldHits.date ? 1 : 0))),
      payee: mean(recent.map((r) => (r.fieldHits.payee ? 1 : 0))),
      total: mean(recent.map((r) => (r.fieldHits.total ? 1 : 0))),
    },
    // recent() は新しい順なので先頭が最新
    latestTs: recent[0]!.ts,
  };
}

function mean(values: number[]): number {
  return round4(values.reduce((a, b) => a + b, 0) / values.length);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
