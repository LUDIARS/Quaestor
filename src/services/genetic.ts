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

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { acquireExclusiveFileLock } from "./exclusive-file-lock.js";

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
  /**
   * best が baseline を下回った世代の連続回数 (再 seed ガード用)。
   * 旧形式の JSON には無いので省略可 (= 0 扱い)。
   */
  belowBaselineStreak?: number;
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
   * { ts, key, generation, evaluated, bestFitness, meanFitness, worstFitness, bestGenome,
   *   baselineFitness, reseeded }
   * 進化が効いているか (fitness の推移) を後から追うための永続ログ。
   */
  logFile?: string;
  /**
   * 再 seed ガード: recordGeneration に baselineFitness が渡され、best がそれを下回る世代が
   * この回数連続したら、次世代を交叉/変異で作らず seed() で作り直す (探索の迷子を切る)。
   * 0 / 未指定で無効。
   */
  reseedAfterBelowBaseline?: number;
}

/** recordGeneration の追加情報 */
export interface RecordGenerationOptions {
  /** 同じコーパスで既定遺伝子を採点した fitness。再 seed ガードの比較対象 */
  baselineFitness?: number;
  /** 評価を始めた時点の世代。現在値と違えば stale な評価として拒否する */
  expectedGeneration?: number;
}

export class StaleGaGenerationError extends Error {
  constructor(readonly key: string, readonly expected: number, readonly actual: number) {
    super(`stale GA generation for ${key}: expected ${expected}, current ${actual}`);
    this.name = "StaleGaGenerationError";
  }
}

export interface RecordGenerationResult<G extends Genome> {
  generation: number;
  best: Evaluated<G> | null;
  /** 再 seed ガードが発動し、次世代を seed() で作り直したか */
  reseeded: boolean;
}

/** history から引いた「その key の歴代最良」 */
export interface GaBest<G extends Genome> {
  key: string;
  generation: number;
  fitness: number;
  genome: G;
}

export class GaStore<G extends Genome> {
  private readonly root: string;
  private readonly schema: GenomeSchema;
  private readonly size: number;
  private readonly elite: number;
  private readonly mutationRate: number;
  private readonly seed: () => G[];
  private readonly logFile: string | null;
  private readonly reseedAfterBelowBaseline: number;

  constructor(opts: GaStoreOptions<G>) {
    this.root = resolve(opts.root);
    this.schema = opts.schema;
    this.size = opts.size ?? 8;
    this.elite = opts.elite ?? 2;
    this.mutationRate = opts.mutationRate ?? 0.3;
    this.seed = opts.seed ?? (() => Array.from({ length: this.size }, () => randomGenome<G>(this.schema)));
    this.logFile = opts.logFile ? resolve(opts.logFile) : null;
    this.reseedAfterBelowBaseline = opts.reseedAfterBelowBaseline ?? 0;
    mkdirSync(this.root, { recursive: true });
  }

  private path(key: string): string {
    return join(this.root, `${sanitize(key)}.json`);
  }

  population(key = "global"): { key: string; generation: number; genomes: G[] } {
    const release = this.acquireStoreLock();
    try {
      const st = this.load(key);
      return { key: st.key, generation: st.generation, genomes: st.population };
    } finally {
      release();
    }
  }

  /** key の集団ファイルが既にあるか (population() と違い、無くても seed しない) */
  has(key: string): boolean {
    return existsSync(this.path(key));
  }

  /** 永続済の集団 key 一覧 (ファイル内の key を返す) */
  keys(): string[] {
    const release = this.acquireStoreLock();
    try {
      if (!existsSync(this.root)) return [];
      const keys: string[] = [];
      for (const f of readdirSync(this.root)) {
        if (!f.endsWith(".json")) continue;
        try {
          const st = JSON.parse(readFileSync(join(this.root, f), "utf8")) as Partial<GaStoreState<G>>;
          if (typeof st.key === "string") keys.push(st.key);
        } catch { /* 壊れたファイルは一覧に出さない (population() が再 seed する) */ }
      }
      return keys.sort();
    } finally {
      release();
    }
  }

  /**
   * key の歴代最良 (history 中の最大 bestFitness)。集団ファイルが無い / 1 世代も
   * 記録が無ければ null (呼び出し側が global / 既定値へフォールバックする)。
   */
  best(key: string): GaBest<G> | null {
    if (!this.has(key)) return null;
    const release = this.acquireStoreLock();
    try {
      const st = this.load(key);
      let top: GaStoreState<G>["history"][number] | null = null;
      for (const h of st.history) {
        if (!top || h.bestFitness > top.bestFitness) top = h;
      }
      return top ? { key: st.key, generation: top.generation, fitness: top.bestFitness, genome: top.bestGenome } : null;
    } finally {
      release();
    }
  }

  recordGeneration(
    key: string,
    evaluated: Evaluated<G>[],
    opts: RecordGenerationOptions = {},
  ): RecordGenerationResult<G> {
    const release = this.acquireStoreLock();
    try {
      const st = this.load(key);
      if (opts.expectedGeneration != null && st.generation !== opts.expectedGeneration) {
        throw new StaleGaGenerationError(key, opts.expectedGeneration, st.generation);
      }
      const best = evaluated.length > 0 ? [...evaluated].sort((a, b) => b.fitness - a.fitness)[0]! : null;

      const reseeded = this.updateBelowBaselineStreak(st, best, opts.baselineFitness);
      st.population = reseeded
        ? this.seed().slice(0, this.size)
        : nextGeneration(this.schema, evaluated, {
          size: this.size, elite: this.elite, mutationRate: this.mutationRate,
        });
      st.generation += 1;
      if (best) {
        st.history.push({ generation: st.generation, bestFitness: round3(best.fitness), bestGenome: best.genome });
        if (st.history.length > 200) st.history = st.history.slice(-200);
      }
      this.save(st);
      this.appendEvolutionLog(st, evaluated, best, opts.baselineFitness, reseeded);
      return { generation: st.generation, best, reseeded };
    } finally {
      release();
    }
  }

  /**
   * 再 seed ガードの連続カウンタを更新し、閾値到達なら true (= この世代は seed で作り直す)。
   * baseline 未指定の呼び出し (撮影時評価など) はカウンタを動かさない。
   */
  private updateBelowBaselineStreak(
    st: GaStoreState<G>,
    best: Evaluated<G> | null,
    baselineFitness: number | undefined,
  ): boolean {
    if (this.reseedAfterBelowBaseline <= 0 || baselineFitness == null || !best) return false;
    st.belowBaselineStreak = best.fitness < baselineFitness ? (st.belowBaselineStreak ?? 0) + 1 : 0;
    if (st.belowBaselineStreak < this.reseedAfterBelowBaseline) return false;
    st.belowBaselineStreak = 0;
    return true;
  }

  /** 学習ログ (JSONL) に 1 世代分を追記。ログ失敗で本処理は止めない。 */
  private appendEvolutionLog(
    st: GaStoreState<G>,
    evaluated: Evaluated<G>[],
    best: Evaluated<G> | null,
    baselineFitness: number | undefined,
    reseeded: boolean,
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
      baselineFitness: baselineFitness != null ? round3(baselineFitness) : null,
      reseeded,
    };
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      appendFileSync(this.logFile, `${JSON.stringify(rec)}\n`, "utf8");
    } catch { /* 学習ログは観測用。書けなくても世代更新は成立させる (best-effort) */ }
  }

  private load(key: string): GaStoreState<G> {
    const p = this.path(key);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")) as GaStoreState<G>; } catch { /* 壊れた集団は下で再 seed する */ }
    }
    const st: GaStoreState<G> = { key, generation: 0, population: this.seed().slice(0, this.size), history: [] };
    this.save(st);
    return st;
  }

  private save(st: GaStoreState<G>): void {
    const target = this.path(st.key);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(st, null, 2), "utf8");
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary); } catch { /* failed atomic-save cleanup */ }
      }
    }
  }

  private acquireStoreLock(): () => void {
    return acquireExclusiveFileLock(join(this.root, ".ga-store.lock"));
  }
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "global";
}
