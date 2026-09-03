/**
 * OCR-GA ベンチマーク 1 回分のオーケストレーション (CLI と夜間ジョブの共通入口)。
 *
 *   sidecar /health (device 確認) → コーパス構築 → ラベルごとに評価器で N 世代 →
 *   bench-report.json (ラベル単位でマージ)
 *
 * 前提不備 (sidecar 不達、device 不一致、空 corpus、同時実行、stale 世代) は黙って縮退せず、
 * ここで例外にする (§7.1 fail-fast)。呼び出し側がログ / exit code に変える。
 *
 * @implements SPEC-OCR-GA-EVAL-003 (spec/feature/ocr-ga-evaluation.md)
 * @implements SPEC-OCR-GA-EVAL-005 (spec/feature/ocr-ga-evaluation.md)
 */

import type Database from "better-sqlite3";
import { join } from "node:path";
import { acquireExclusiveFileLock } from "../exclusive-file-lock.js";
import { createOcrGaStore } from "../ocr-ga.js";
import type { OcrSidecarClient } from "../ocr-sidecar-client.js";
import type { ReceiptStorage } from "../receipt-storage.js";
import { buildBenchCorpus } from "./corpus-builder.js";
import { OcrGaBenchEvaluator, type EvalProgress } from "./evaluator.js";
import { waitForSidecarHealth, type SidecarReadinessOptions } from "./sidecar-readiness.js";
import { BENCH_REPORT_FILE, mergeBenchReport, readBenchReport, writeBenchReport } from "./report.js";
import type { BenchLogger, BenchReport, LabelBenchReport } from "./types.js";

export interface GaBenchRunOptions {
  /** 読み取りにしか使わない (CLI は read-only で開く) */
  db: Database.Database;
  storage: Pick<ReceiptStorage, "load">;
  /** GA 集団 / evolution.jsonl / bench-report.json の置き場 (本番 or --out) */
  gaRoot: string;
  sidecar: OcrSidecarClient;
  /** 走らせるラベル。未指定はコーパスにある全ラベル */
  labels?: string[];
  generations: number;
  /** ラベルごとのコーパス上限 (新しい順) */
  limit?: number;
  /** 1 世代で評価する個体数の上限 */
  population?: number;
  costPerSecond: number;
  /** バッチ sidecar に期待する device。gpu 指定で sidecar が gpu でなければ失敗 */
  expectedDevice?: "cpu" | "gpu";
  /** sidecar `/health` の待ち方 (GPU の cold start 用)。省略で既定 (4 回 / 1 秒間隔) */
  healthReadiness?: Omit<SidecarReadinessOptions, "logger">;
  logger?: BenchLogger;
  onProgress?: (p: EvalProgress) => void;
  now?: () => number;
}

export async function runGaBench(opts: GaBenchRunOptions): Promise<BenchReport> {
  const release = acquireExclusiveFileLock(join(opts.gaRoot, ".ga-bench.lock"));
  try {
    return await runGaBenchLocked(opts);
  } finally {
    release();
  }
}

async function runGaBenchLocked(opts: GaBenchRunOptions): Promise<BenchReport> {
  // GPU sidecar は最初の /health で CUDA を初期化するため、cold start は client の
  // /health タイムアウト (5 秒) より長い。数回だけ待ってから不達と判定する
  const health = await waitForSidecarHealth(opts.sidecar, { ...opts.healthReadiness, logger: opts.logger });
  if (!health.ok) throw new Error(`OCR sidecar at ${opts.sidecar.baseUrl} reports ok=false`);
  if (opts.expectedDevice === "gpu" && health.device !== "gpu") {
    throw new Error(
      `gaBench.device=gpu but sidecar ${opts.sidecar.baseUrl} runs on ${health.device ?? "unknown"}`
      + (health.deviceError ? ` (${health.deviceError})` : ""),
    );
  }

  const corpora = buildBenchCorpus(opts.db, { limit: opts.limit });
  const selected = selectLabels(corpora, opts.labels);
  const emptyLabels = selected.filter((corpus) => corpus.train.length === 0).map((corpus) => corpus.label);
  if (emptyLabels.length > 0) {
    throw new Error(`ga bench has no train entries for: ${emptyLabels.join(", ")}`);
  }

  const ga = createOcrGaStore(opts.gaRoot);
  const evaluator = new OcrGaBenchEvaluator({
    ga,
    sidecar: opts.sidecar,
    loadImage: (p) => opts.storage.load(p),
    costPerSecond: opts.costPerSecond,
    now: opts.now,
    logger: opts.logger,
  });

  const labels: LabelBenchReport[] = [];
  for (const corpus of selected) {
    opts.logger?.info?.(
      { label: corpus.label, train: corpus.train.length, holdout: corpus.holdout.length, generations: opts.generations },
      "ga bench label start",
    );
    labels.push(await evaluator.runLabel(corpus, {
      generations: opts.generations,
      population: opts.population,
      onProgress: opts.onProgress,
    }));
  }

  const report: BenchReport = {
    ts: new Date().toISOString(),
    sidecarUrl: opts.sidecar.baseUrl,
    device: health.device,
    labels,
  };
  const reportPath = join(opts.gaRoot, BENCH_REPORT_FILE);
  writeBenchReport(reportPath, mergeBenchReport(readBenchReport(reportPath), report));
  return report;
}

function selectLabels<T extends { label: string }>(corpora: T[], wanted: string[] | undefined): T[] {
  if (!wanted || wanted.length === 0) return corpora;
  const available = new Set(corpora.map((c) => c.label));
  const missing = wanted.filter((l) => !available.has(l));
  if (missing.length > 0) {
    throw new Error(`label not in corpus: ${missing.join(", ")} (available: ${[...available].join(", ") || "none"})`);
  }
  const want = new Set(wanted);
  return corpora.filter((c) => want.has(c.label));
}
