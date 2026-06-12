/**
 * 汎用 遺伝的アルゴリズム エンジン (遺伝子スキーマ駆動)。
 *
 * 特定ドメイン (OCR パラメータ等) に依存しない。遺伝子を「スキーマ」で宣言し、
 * ランダム生成 / 突然変異 / 交叉 / 世代更新 / 永続を汎用に提供する。
 * ブラックボックス・アーキテクチャ (モデル/パラメータ自動探索) でも再利用する想定。
 *
 *   - 純関数: randomGenome / mutate / crossover / nextGeneration (rng 注入でテスト可能)
 *   - 永続:   GaStore<G> (key ごとの集団を JSON で保存し世代を進める)
 *
 * fitness の計算 (評価) は呼び出し側の責務。本モジュールは「探索の骨格」のみ。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

/** 遺伝子 1 個の宣言 */
export type GeneSpec =
  | { kind: "number"; min: number; max: number; round?: number; /** 突然変異幅 = span × jitter (既定 0.25) */ jitter?: number }
  | { kind: "choice"; options: ReadonlyArray<number | string> }
  | { kind: "bool" };

/** 遺伝子スキーマ: フィールド名 → GeneSpec */
export type GenomeSchema = Record<string, GeneSpec>;

/** 遺伝子 (スキーマで型付けされる前のプリミティブ集合) */
export type Genome = Record<string, number | string | boolean>;

export interface Evaluated<G extends Genome = Genome> {
  genome: G;
  /** 0..1、高いほど良い */
  fitness: number;
}

// ---------------------------------------------------------------------------
// 純粋な遺伝子操作
// ---------------------------------------------------------------------------

function clampRound(v: number, spec: { min: number; max: number; round?: number }): number {
  const c = Math.min(spec.max, Math.max(spec.min, v));
  if (spec.round == null) return c;
  const f = 10 ** spec.round;
  return Math.round(c * f) / f;
}

function randomGene(spec: GeneSpec, rng: () => number): number | string | boolean {
  switch (spec.kind) {
    case "number": return clampRound(spec.min + rng() * (spec.max - spec.min), spec);
    case "choice": return spec.options[Math.floor(rng() * spec.options.length)] ?? spec.options[0]!;
    case "bool":   return rng() < 0.5;
  }
}

export function randomGenome<G extends Genome>(schema: GenomeSchema, rng: () => number = Math.random): G {
  const g: Genome = {};
  for (const [k, spec] of Object.entries(schema)) g[k] = randomGene(spec, rng);
  return g as G;
}

/** 各遺伝子を確率 rate で摂動する */
export function mutate<G extends Genome>(schema: GenomeSchema, genome: G, rate: number, rng: () => number = Math.random): G {
  const g: Genome = { ...genome };
  for (const [k, spec] of Object.entries(schema)) {
    if (rng() >= rate) continue;
    if (spec.kind === "number") {
      const span = (spec.max - spec.min) * (spec.jitter ?? 0.25);
      g[k] = clampRound((genome[k] as number) + (rng() * 2 - 1) * span, spec);
    } else {
      g[k] = randomGene(spec, rng); // choice / bool は再抽選
    }
  }
  return g as G;
}

/** 一様交叉: 各遺伝子を 2 親からランダムに継承 */
export function crossover<G extends Genome>(schema: GenomeSchema, a: G, b: G, rng: () => number = Math.random): G {
  const g: Genome = {};
  for (const k of Object.keys(schema)) g[k] = rng() < 0.5 ? a[k]! : b[k]!;
  return g as G;
}

export interface GaOptions {
  size: number;
  elite: number;
  mutationRate: number;
  rng?: () => number;
}

/** 評価済個体から エリート保存 + ルーレット選択 + 交叉 + 突然変異で次世代を作る */
export function nextGeneration<G extends Genome>(
  schema: GenomeSchema,
  evaluated: Evaluated<G>[],
  opts: GaOptions,
): G[] {
  const rng = opts.rng ?? Math.random;
  const sorted = [...evaluated].sort((a, b) => b.fitness - a.fitness);
  if (sorted.length === 0) {
    return Array.from({ length: opts.size }, () => randomGenome<G>(schema, rng));
  }
  const next: G[] = sorted.slice(0, Math.min(opts.elite, sorted.length)).map((e) => e.genome);

  const weights = sorted.map((e) => Math.max(0.05, e.fitness));
  const total = weights.reduce((s, w) => s + w, 0);
  const pickParent = (): G => {
    let t = rng() * total;
    for (let i = 0; i < sorted.length; i++) {
      t -= weights[i]!;
      if (t <= 0) return sorted[i]!.genome;
    }
    return sorted[0]!.genome;
  };

  while (next.length < opts.size) {
    next.push(mutate(schema, crossover(schema, pickParent(), pickParent(), rng), opts.mutationRate, rng));
  }
  return next.slice(0, opts.size);
}

// ---------------------------------------------------------------------------
// 永続: key ごとの集団を JSON で保存し世代を進める
// ---------------------------------------------------------------------------

export interface GaStoreState<G extends Genome> {
  key: string;
  generation: number;
  population: G[];
  history: Array<{ generation: number; bestFitness: number; bestGenome: G }>;
}

export interface GaStoreOptions<G extends Genome> {
  root: string;
  schema: GenomeSchema;
  size?: number;
  elite?: number;
  mutationRate?: number;
  /** 初期集団 (例: 既定値 + ランダム)。未指定はランダム size 個体 */
  seed?: () => G[];
  /**
   * 学習ログ (JSONL)。指定すると recordGeneration ごとに 1 行追記する:
   * { ts, key, generation, evaluated, bestFitness, meanFitness, worstFitness, bestGenome }
   * 進化が効いているか (fitness の推移) を後から追うための永続ログ。
   */
  logFile?: string;
}

export class GaStore<G extends Genome> {
  private readonly root: string;
  private readonly schema: GenomeSchema;
  private readonly size: number;
  private readonly elite: number;
  private readonly mutationRate: number;
  private readonly seed: () => G[];
  private readonly logFile: string | null;

  constructor(opts: GaStoreOptions<G>) {
    this.root = resolve(opts.root);
    this.schema = opts.schema;
    this.size = opts.size ?? 8;
    this.elite = opts.elite ?? 2;
    this.mutationRate = opts.mutationRate ?? 0.3;
    this.seed = opts.seed ?? (() => Array.from({ length: this.size }, () => randomGenome<G>(this.schema)));
    this.logFile = opts.logFile ? resolve(opts.logFile) : null;
    mkdirSync(this.root, { recursive: true });
  }

  private path(key: string): string {
    return join(this.root, `${sanitize(key)}.json`);
  }

  population(key = "global"): { key: string; generation: number; genomes: G[] } {
    const st = this.load(key);
    return { key: st.key, generation: st.generation, genomes: st.population };
  }

  recordGeneration(key: string, evaluated: Evaluated<G>[]): { generation: number; best: Evaluated<G> | null } {
    const st = this.load(key);
    const best = evaluated.length > 0 ? [...evaluated].sort((a, b) => b.fitness - a.fitness)[0]! : null;

    st.population = nextGeneration(this.schema, evaluated, {
      size: this.size, elite: this.elite, mutationRate: this.mutationRate,
    });
    st.generation += 1;
    if (best) {
      st.history.push({ generation: st.generation, bestFitness: round3(best.fitness), bestGenome: best.genome });
      if (st.history.length > 200) st.history = st.history.slice(-200);
    }
    this.save(st);
    this.appendEvolutionLog(st, evaluated, best);
    return { generation: st.generation, best };
  }

  /** 学習ログ (JSONL) に 1 世代分を追記。ログ失敗で本処理は止めない。 */
  private appendEvolutionLog(
    st: GaStoreState<G>,
    evaluated: Evaluated<G>[],
    best: Evaluated<G> | null,
  ): void {
    if (!this.logFile) return;
    const fits = evaluated.map((e) => e.fitness);
    const sum = fits.reduce((s, v) => s + v, 0);
    const rec = {
      ts: new Date().toISOString(),
      key: st.key,
      generation: st.generation,
      evaluated: fits.length,
      bestFitness:  best ? round3(best.fitness) : null,
      meanFitness:  fits.length > 0 ? round3(sum / fits.length) : null,
      worstFitness: fits.length > 0 ? round3(Math.min(...fits)) : null,
      bestGenome: best?.genome ?? null,
    };
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      appendFileSync(this.logFile, `${JSON.stringify(rec)}\n`, "utf8");
    } catch { /* ignore */ }
  }

  private load(key: string): GaStoreState<G> {
    const p = this.path(key);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")) as GaStoreState<G>; } catch { /* reseed */ }
    }
    const st: GaStoreState<G> = { key, generation: 0, population: this.seed().slice(0, this.size), history: [] };
    this.save(st);
    return st;
  }

  private save(st: GaStoreState<G>): void {
    writeFileSync(this.path(st.key), JSON.stringify(st, null, 2), "utf8");
  }
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "global";
}
