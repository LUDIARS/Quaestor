import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  randomGenome, mutate, crossover, nextGeneration, GaStore,
  type GenomeSchema, type Genome,
} from "../src/services/genetic.js";
import { acquireExclusiveFileLock } from "../src/services/exclusive-file-lock.js";
import { createOcrGaStore, defaultOcrGenome, OCR_GENE_SCHEMA, type OcrGenome } from "../src/services/ocr-ga.js";

const SCHEMA: GenomeSchema = {
  a: { kind: "number", min: 0, max: 10, round: 2 },
  b: { kind: "choice", options: [100, 200, 300] },
  c: { kind: "bool" },
};

/** 決定的 rng (線形合同法) */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

describe("genetic engine (汎用)", () => {
  it("randomGenome はスキーマの範囲/型を守る", () => {
    const rng = seeded(1);
    for (let i = 0; i < 50; i++) {
      const g = randomGenome(SCHEMA, rng);
      expect(g.a as number).toBeGreaterThanOrEqual(0);
      expect(g.a as number).toBeLessThanOrEqual(10);
      expect([100, 200, 300]).toContain(g.b);
      expect(typeof g.c).toBe("boolean");
    }
  });

  it("mutate rate=0 は不変、rate=1 は範囲内で変化", () => {
    const g = randomGenome(SCHEMA, seeded(2));
    expect(mutate(SCHEMA, g, 0, seeded(3))).toEqual(g);
    const m = mutate(SCHEMA, g, 1, seeded(4));
    expect(m.a as number).toBeGreaterThanOrEqual(0);
    expect(m.a as number).toBeLessThanOrEqual(10);
  });

  it("crossover は各遺伝子をどちらかの親から取る", () => {
    const a: Genome = { a: 1, b: 100, c: true };
    const b: Genome = { a: 9, b: 300, c: false };
    const child = crossover(SCHEMA, a, b, seeded(5));
    expect([1, 9]).toContain(child.a);
    expect([100, 300]).toContain(child.b);
    expect([true, false]).toContain(child.c);
  });

  it("nextGeneration はサイズを守りエリート(最良)を残す", () => {
    const evaluated = [
      { genome: { a: 1, b: 100, c: true } as Genome, fitness: 0.2 },
      { genome: { a: 5, b: 200, c: false } as Genome, fitness: 0.9 },
      { genome: { a: 9, b: 300, c: true } as Genome, fitness: 0.5 },
    ];
    const next = nextGeneration(SCHEMA, evaluated, { size: 6, elite: 1, mutationRate: 0.3, rng: seeded(7) });
    expect(next).toHaveLength(6);
    // エリート (fitness 0.9 の個体) が残る
    expect(next[0]).toEqual({ a: 5, b: 200, c: false });
  });

  it("評価ゼロなら全ランダムで size 個体", () => {
    const next = nextGeneration(SCHEMA, [], { size: 4, elite: 2, mutationRate: 0.3, rng: seeded(8) });
    expect(next).toHaveLength(4);
  });
});

describe("GaStore 永続", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qga-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("population は seed して保存、recordGeneration で世代が進む", () => {
    const store = new GaStore<Genome>({ root: join(root, "s"), schema: SCHEMA, size: 5, elite: 1 });
    const p0 = store.population("global");
    expect(p0.generation).toBe(0);
    expect(p0.genomes).toHaveLength(5);
    expect(existsSync(join(root, "s", "global.json"))).toBe(true);

    const evaluated = p0.genomes.map((genome, i) => ({ genome, fitness: i / 5 }));
    const res = store.recordGeneration("global", evaluated);
    expect(res.generation).toBe(1);
    expect(res.best?.fitness).toBeCloseTo(0.8);
    expect(store.population("global").generation).toBe(1);
  });

  it("key ごとに別集団 + 不正文字はサニタイズ", () => {
    const store = new GaStore<Genome>({ root: join(root, "k"), schema: SCHEMA, size: 3 });
    store.population("サイゼリヤ/中目黒");
    store.population("global");
    // ファイルは sanitize されて作られる
    expect(existsSync(join(root, "k", "global.json"))).toBe(true);
  });

  it("logFile 指定時は recordGeneration ごとに JSONL 学習ログを追記する", () => {
    const logFile = join(root, "l", "evolution.jsonl");
    const store = new GaStore<Genome>({ root: join(root, "l"), schema: SCHEMA, size: 4, elite: 1, logFile });
    const p = store.population("global");
    const evaluated = p.genomes.map((genome, i) => ({ genome, fitness: i / 4 }));

    store.recordGeneration("global", evaluated);
    store.recordGeneration("store-a", evaluated.slice(0, 2));

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const rec1 = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec1.key).toBe("global");
    expect(rec1.generation).toBe(1);
    expect(rec1.evaluated).toBe(4);
    expect(rec1.bestFitness).toBeCloseTo(0.75);
    expect(rec1.meanFitness).toBeCloseTo((0 + 0.25 + 0.5 + 0.75) / 4);
    expect(rec1.worstFitness).toBe(0);
    expect(rec1.bestGenome).toBeTruthy();
    expect(typeof rec1.ts).toBe("string");
    const rec2 = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(rec2.key).toBe("store-a");
  });

  it("logFile 未指定ならログを書かない (後方互換)", () => {
    const store = new GaStore<Genome>({ root: join(root, "n"), schema: SCHEMA, size: 3 });
    const p = store.population("global");
    store.recordGeneration("global", p.genomes.map((genome) => ({ genome, fitness: 0.5 })));
    expect(existsSync(join(root, "n", "evolution.jsonl"))).toBe(false);
  });

  it("has / keys / best: 集団ファイルの有無と歴代最良", () => {
    const store = new GaStore<Genome>({ root: join(root, "b"), schema: SCHEMA, size: 3 });
    expect(store.has("global")).toBe(false);
    expect(store.best("global")).toBeNull();
    const p = store.population("global");
    expect(store.has("global")).toBe(true);
    expect(store.best("global")).toBeNull(); // seed しただけでは記録なし
    store.recordGeneration("global", [{ genome: p.genomes[0]!, fitness: 0.4 }]);
    store.recordGeneration("global", [{ genome: p.genomes[1]!, fitness: 0.9 }]);
    store.recordGeneration("global", [{ genome: p.genomes[2]!, fitness: 0.6 }]);
    expect(store.best("global")).toEqual({ key: "global", generation: 2, fitness: 0.9, genome: p.genomes[1] });
    store.population("tag:long");
    expect(store.keys()).toEqual(["global", "tag:long"]);
  });

  it("exclusive file lock は同じ永続先の同時更新を拒否し、release 後は再取得できる", () => {
    const lockPath = join(root, "locks", "store.lock");
    const release = acquireExclusiveFileLock(lockPath);
    expect(() => acquireExclusiveFileLock(lockPath)).toThrow(/locked by another process/);
    release();
    const reacquired = acquireExclusiveFileLock(lockPath);
    reacquired();
  });

  it("recordGeneration は評価開始後に世代が変わった stale update を拒否する", () => {
    const path = join(root, "cas");
    const first = new GaStore<Genome>({ root: path, schema: SCHEMA, size: 3 });
    const second = new GaStore<Genome>({ root: path, schema: SCHEMA, size: 3 });
    const snapshot = first.population("global");
    const evaluated = snapshot.genomes.map((genome) => ({ genome, fitness: 0.5 }));

    second.recordGeneration("global", evaluated, { expectedGeneration: snapshot.generation });
    expect(() => first.recordGeneration("global", evaluated, { expectedGeneration: snapshot.generation }))
      .toThrow(/stale GA generation/);
    expect(first.population("global").generation).toBe(1);
  });

  it("再 seed ガード: best が baseline を下回る世代が N 回続いたら seed() で作り直す", () => {
    const marker: Genome = { a: 7.77, b: 300, c: true };
    const logFile = join(root, "r", "evolution.jsonl");
    const store = new GaStore<Genome>({
      root: join(root, "r"), schema: SCHEMA, size: 3, elite: 1, logFile,
      reseedAfterBelowBaseline: 2,
      seed: () => [marker, { a: 1, b: 100, c: false }, { a: 2, b: 200, c: false }],
    });
    const weak = { genome: { a: 5, b: 200, c: false } as Genome, fitness: 0.2 };

    // 1 回目: 下回る (streak 1) → 通常進化
    expect(store.recordGeneration("global", [weak], { baselineFitness: 0.5 }).reseeded).toBe(false);
    // baseline 以上でリセット
    expect(store.recordGeneration("global", [{ ...weak, fitness: 0.5 }], { baselineFitness: 0.5 }).reseeded).toBe(false);
    // 下回る × 2 で再 seed
    expect(store.recordGeneration("global", [weak], { baselineFitness: 0.5 }).reseeded).toBe(false);
    const r = store.recordGeneration("global", [weak], { baselineFitness: 0.5 });
    expect(r.reseeded).toBe(true);
    expect(r.generation).toBe(4);
    expect(store.population("global").genomes[0]).toEqual(marker);
    // baseline 無しの呼び出し (撮影時経路) はカウンタを動かさない
    expect(store.recordGeneration("global", [weak]).reseeded).toBe(false);

    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.reseeded)).toEqual([false, false, false, true, false]);
    expect(lines[0]!.baselineFitness).toBe(0.5);
    expect(lines[4]!.baselineFitness).toBeNull();
  });

  it("再 seed ガード未設定 (既定) では baseline を渡しても再 seed しない", () => {
    const store = new GaStore<Genome>({ root: join(root, "d"), schema: SCHEMA, size: 3 });
    const weak = { genome: { a: 5, b: 200, c: false } as Genome, fitness: 0.1 };
    for (let i = 0; i < 6; i++) {
      expect(store.recordGeneration("global", [weak], { baselineFitness: 0.9 }).reseeded).toBe(false);
    }
  });
});

describe("OCR-GA インスタンス", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qocrga-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("初期集団の第1個体は default 遺伝子", () => {
    const store = createOcrGaStore(join(root, "ga"));
    const p = store.population("global");
    expect(p.genomes[0]).toEqual(defaultOcrGenome());
    expect(p.genomes).toHaveLength(8);
  });

  it("OCR スキーマの遺伝子が範囲内", () => {
    const store = createOcrGaStore(join(root, "ga2"));
    const g = store.population("global").genomes[1] as OcrGenome;
    expect(g.detThresh).toBeGreaterThanOrEqual(OCR_GENE_SCHEMA.detThresh.kind === "number" ? OCR_GENE_SCHEMA.detThresh.min : 0);
    expect([736, 960, 1280, 1600]).toContain(g.limitSideLen);
  });
});
