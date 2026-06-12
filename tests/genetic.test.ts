import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  randomGenome, mutate, crossover, nextGeneration, GaStore,
  type GenomeSchema, type Genome,
} from "../src/services/genetic.js";
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
