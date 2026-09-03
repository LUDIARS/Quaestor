/**
 * ラベル別コーパスで現世代の全個体を採点し、1 周 = 1 世代として GA を進める評価器。
 *
 *  - 1 個体の fitness = train コーパスの平均 (1 レシート 1 世代はやめ、真値ノイズを集団に入れない)
 *  - baseline = 既定遺伝子を同じ train で採点した値。再 seed ガードの比較対象
 *  - best は holdout でも採点し、過学習 (train − holdout) を見られるようにする
 *  - 同じ遺伝子 × 同じ画像の /detect はキャッシュ (既定遺伝子は baseline と elite で重なる)
 *
 * sidecar は OcrSidecarClient (DI)。画像は loadImage (DI) で読む。
 *
 * @implements SPEC-OCR-GA-EVAL-003 (spec/feature/ocr-ga-evaluation.md)
 */

import type { GaStore } from "../genetic.js";
import { defaultOcrGenome, type OcrGenome } from "../ocr-ga.js";
import { computeOcrFitness } from "../ocr-ga-fitness.js";
import type { DetectResult, OcrSidecarClient } from "../ocr-sidecar-client.js";
import type { BenchCorpusEntry, BenchLogger, FieldHitRate, GenomeScore, LabelBenchReport, LabelCorpus, ScoreSummary } from "./types.js";

export interface EvaluatorDeps {
  ga: GaStore<OcrGenome>;
  sidecar: OcrSidecarClient;
  /** ReceiptStorage.load 相当。無ければ null */
  loadImage: (imagePath: string) => Buffer | null;
  /** fitness のコスト項係数 (1 秒あたり)。0 で無効 */
  costPerSecond: number;
  now?: () => number;
  logger?: BenchLogger;
}

export interface EvalProgress {
  label: string;
  generation: number;
  /** 評価済個体数 */
  attempt: number;
  total: number;
  fitness: number;
}

export interface RunLabelOptions {
  generations: number;
  /** 1 世代で評価する個体数の上限 (集団の先頭から)。未指定は全個体 */
  population?: number;
  onProgress?: (p: EvalProgress) => void;
}

type CachedDetect = DetectResult | { error: string };

interface GenerationOutcome {
  generation: number;
  reseeded: boolean;
  population: number;
  scores: GenomeScore[];
  best: GenomeScore;
  baseline: GenomeScore;
  holdoutBest: GenomeScore | null;
  holdoutBaseline: GenomeScore | null;
}

export class OcrGaBenchEvaluator {
  private readonly cache = new Map<string, CachedDetect>();
  private readonly now: () => number;
  private detectCalls = 0;

  constructor(private readonly deps: EvaluatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async runLabel(corpus: LabelCorpus, opts: RunLabelOptions): Promise<LabelBenchReport> {
    if (corpus.train.length === 0) throw new Error(`label ${corpus.label}: train corpus is empty`);
    if (!Number.isInteger(opts.generations) || opts.generations < 1) {
      throw new Error(`label ${corpus.label}: generations must be a positive integer`);
    }

    const started = this.now();
    const callsBefore = this.detectCalls;
    let individualMs = 0;
    let individuals = 0;
    let errors = 0;
    let last: GenerationOutcome | null = null;

    for (let g = 0; g < opts.generations; g++) {
      const outcome = await this.runGeneration(corpus, opts);
      for (const s of outcome.scores) {
        individualMs += s.totalElapsedMs;
        individuals += 1;
        errors += s.errors;
      }
      last = outcome;
    }
    if (!last) throw new Error(`label ${corpus.label}: no generation was evaluated`);

    const fits = last.scores.map((s) => s.fitness);
    return {
      label: corpus.label,
      corpus: { train: corpus.train.length, holdout: corpus.holdout.length, total: corpus.train.length + corpus.holdout.length },
      generation: last.generation,
      generationsRun: opts.generations,
      population: last.population,
      best: { ...summaryOf(last.best), genome: last.best.genome },
      mean: round4(fits.reduce((s, v) => s + v, 0) / fits.length),
      worst: round4(Math.min(...fits)),
      baseline: summaryOf(last.baseline),
      holdout: {
        best: last.holdoutBest ? summaryOf(last.holdoutBest) : null,
        baseline: last.holdoutBaseline ? summaryOf(last.holdoutBaseline) : null,
      },
      secondsPerIndividual: individuals > 0 ? round2(individualMs / individuals / 1000) : 0,
      totalSeconds: round2((this.now() - started) / 1000),
      detectCalls: this.detectCalls - callsBefore,
      errors,
      reseeded: last.reseeded,
      ts: new Date().toISOString(),
    };
  }

  /** 1 個体をコーパスで採点 (fitness = 平均、hit 率 = 復元できたレシートの割合) */
  async scoreGenome(genome: OcrGenome, entries: readonly BenchCorpusEntry[]): Promise<GenomeScore> {
    let fitnessSum = 0;
    const hits = { date: 0, payee: 0, total: 0 };
    const applicable = { date: 0, payee: 0, total: 0 };
    let elapsedSum = 0;
    let ok = 0;
    let errors = 0;

    for (const entry of entries) {
      const availability = computeOcrFitness([], entry.truth).fieldScores;
      if (availability.date != null) applicable.date += 1;
      if (availability.payee != null) applicable.payee += 1;
      if (availability.total != null) applicable.total += 1;
      const det = await this.detectCached(genome, entry);
      if ("error" in det) {
        errors += 1; // 画像欠損 / sidecar 失敗は 0 点 (集団間で公平に効く)
        continue;
      }
      const r = computeOcrFitness(det.lines, entry.truth, { elapsedMs: det.elapsedMs, costPerSecond: this.deps.costPerSecond });
      fitnessSum += r.fitness;
      if (r.fieldHits.date) hits.date += 1;
      if (r.fieldHits.payee) hits.payee += 1;
      if (r.fieldHits.total) hits.total += 1;
      elapsedSum += det.elapsedMs;
      ok += 1;
    }

    const n = entries.length;
    return {
      genome,
      fitness: n > 0 ? round4(fitnessSum / n) : 0,
      fieldHitRate: rateOf(hits, applicable),
      meanElapsedMs: ok > 0 ? Math.round(elapsedSum / ok) : 0,
      totalElapsedMs: elapsedSum,
      evaluated: n,
      errors,
    };
  }

  private async runGeneration(corpus: LabelCorpus, opts: RunLabelOptions): Promise<GenerationOutcome> {
    const pop = this.deps.ga.population(corpus.label);
    const genomes = opts.population != null ? pop.genomes.slice(0, Math.max(1, opts.population)) : pop.genomes;

    const baseline = await this.scoreGenome(defaultOcrGenome(), corpus.train);
    if (baseline.errors === corpus.train.length) {
      // 全滅は測定系の故障 (sidecar 死亡 / 画像不在)。0 点集団で世代を進めない
      throw new Error(`label ${corpus.label}: sidecar detect failed for every train image`);
    }

    const scores: GenomeScore[] = [];
    for (let i = 0; i < genomes.length; i++) {
      const s = await this.scoreGenome(genomes[i]!, corpus.train);
      scores.push(s);
      opts.onProgress?.({ label: corpus.label, generation: pop.generation, attempt: i + 1, total: genomes.length, fitness: s.fitness });
    }
    const best = scores.reduce((a, b) => (b.fitness > a.fitness ? b : a));
    const holdoutBest = corpus.holdout.length > 0 ? await this.scoreGenome(best.genome, corpus.holdout) : null;
    const holdoutBaseline = corpus.holdout.length > 0 ? await this.scoreGenome(defaultOcrGenome(), corpus.holdout) : null;

    const rec = this.deps.ga.recordGeneration(
      corpus.label,
      scores.map((s) => ({ genome: s.genome, fitness: s.fitness })),
      { baselineFitness: baseline.fitness, expectedGeneration: pop.generation },
    );
    this.deps.logger?.info?.(
      { label: corpus.label, generation: rec.generation, best: best.fitness, baseline: baseline.fitness, reseeded: rec.reseeded },
      "ga bench generation recorded",
    );
    return { generation: rec.generation, reseeded: rec.reseeded, population: genomes.length, scores, best, baseline, holdoutBest, holdoutBaseline };
  }

  private async detectCached(genome: OcrGenome, entry: BenchCorpusEntry): Promise<CachedDetect> {
    const key = `${genomeCacheKey(genome)}|${entry.receiptId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    let result: CachedDetect;
    const image = this.deps.loadImage(entry.imagePath);
    if (!image) {
      result = { error: `image not found: ${entry.imagePath}` };
      this.deps.logger?.warn?.({ receiptId: entry.receiptId }, "ga bench image missing");
    } else {
      this.detectCalls += 1;
      try {
        result = await this.deps.sidecar.detect(image, genome, `${entry.receiptId}.jpg`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        result = { error: message };
        this.deps.logger?.warn?.({ receiptId: entry.receiptId, err: message }, "ga bench detect failed");
      }
    }
    this.cache.set(key, result);
    return result;
  }
}

/** sidecar 側の _genome_key と同じ丸めで同一視する */
export function genomeCacheKey(g: OcrGenome): string {
  return [
    g.detThresh.toFixed(3), g.boxThresh.toFixed(3), g.unclipRatio.toFixed(3),
    String(Math.trunc(g.limitSideLen)), g.useDilation ? "1" : "0", g.dropScore.toFixed(3),
  ].join(",");
}

function summaryOf(s: GenomeScore): ScoreSummary {
  return { fitness: s.fitness, fieldHitRate: s.fieldHitRate };
}

function rateOf(
  hits: { date: number; payee: number; total: number },
  applicable: { date: number; payee: number; total: number },
): FieldHitRate {
  return {
    date: applicable.date > 0 ? round4(hits.date / applicable.date) : 0,
    payee: applicable.payee > 0 ? round4(hits.payee / applicable.payee) : 0,
    total: applicable.total > 0 ? round4(hits.total / applicable.total) : 0,
  };
}

function round4(v: number): number { return Math.round(v * 10_000) / 10_000; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
