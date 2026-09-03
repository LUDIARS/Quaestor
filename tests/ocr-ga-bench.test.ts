import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { splitHoldout, isHoldout, holdoutBucket } from "../src/services/ocr-ga-bench/corpus-split.js";
import {
  buildBenchCorpus, detectSampleColumns, labelsForRow, parseSampleTags,
} from "../src/services/ocr-ga-bench/corpus-builder.js";
import { runGaBench } from "../src/services/ocr-ga-bench/bench-runner.js";
import { OcrGaBenchEvaluator, genomeCacheKey } from "../src/services/ocr-ga-bench/evaluator.js";
import { mergeBenchReport, readBenchReport, writeBenchReport } from "../src/services/ocr-ga-bench/report.js";
import { createOcrGaStore, defaultOcrGenome, type OcrGenome } from "../src/services/ocr-ga.js";
import { ReceiptStorage } from "../src/services/receipt-storage.js";
import type { DetectResult, OcrSidecarClient, SidecarHealth } from "../src/services/ocr-sidecar-client.js";
import type { BenchReport, LabelBenchReport } from "../src/services/ocr-ga-bench/types.js";

// ---------------------------------------------------------------------------
// テスト用の DB / sidecar
// ---------------------------------------------------------------------------

function seedReceipt(
  db: Database.Database,
  repo: ReceiptsRepo,
  id: string,
  opts: { status?: "done" | "manual" | "pending"; image?: boolean; total?: number; capturedAt?: number } = {},
): void {
  repo.insert({ id, captured_at: opts.capturedAt ?? 1_700_000_000, image_path: opts.image === false ? null : `2026/09/${id}.jpg` });
  const status = opts.status ?? "done";
  if (status !== "pending") {
    repo.setOcrResult(id, {
      ocr_status: status,
      date: "2026-09-02",
      payee: "成城石井",
      total: opts.total ?? 1234,
      items: [{ name: "牛乳", price: 220 }],
    });
  }
  // captured_at は insert で now に上書きされないよう明示更新
  db.prepare("UPDATE receipts SET captured_at = ? WHERE id = ?").run(opts.capturedAt ?? 1_700_000_000, id);
}

/**
 * schema v19 以降は migration がサンプルラベル列を作る。 それ以前の DB を想定した
 * 経路も残っているので、 テストは「列がある / 無い」の両方を明示的に作って確かめる。
 */
function hasColumn(db: Database.Database, column: string): boolean {
  return db.prepare("SELECT 1 FROM pragma_table_info('receipts') WHERE name = ?").get(column) !== undefined;
}

function addSampleColumns(db: Database.Database): void {
  if (!hasColumn(db, "sample_role")) db.exec("ALTER TABLE receipts ADD COLUMN sample_role TEXT");
  if (!hasColumn(db, "sample_tags")) db.exec("ALTER TABLE receipts ADD COLUMN sample_tags TEXT");
}

/** schema v19 より前の DB (列がまだ無い) を再現する。 索引を先に落とさないと DROP COLUMN が失敗する。 */
function dropSampleColumns(db: Database.Database): void {
  db.exec("DROP INDEX IF EXISTS idx_receipts_sample_role");
  if (hasColumn(db, "sample_role")) db.exec("ALTER TABLE receipts DROP COLUMN sample_role");
  if (hasColumn(db, "sample_tags")) db.exec("ALTER TABLE receipts DROP COLUMN sample_tags");
}

function setSample(db: Database.Database, id: string, role: string | null, tags: string[] | string | null): void {
  db.prepare("UPDATE receipts SET sample_role = ?, sample_tags = ? WHERE id = ?")
    .run(role, Array.isArray(tags) ? JSON.stringify(tags) : tags, id);
}

/**
 * 偽 sidecar: detThresh が 0.35 未満の遺伝子は真値どおりの行を返し、それ以外はゴミ行を返す。
 * → 既定遺伝子 (0.3) は満点、ランダム個体は遺伝子次第。elapsed は limitSideLen に比例。
 */
class FakeSidecar implements OcrSidecarClient {
  readonly baseUrl = "http://fake-sidecar";
  calls = 0;
  healthResult: SidecarHealth = { ok: true, model: "fake", device: "cpu", requestedDevice: null, deviceError: null, paddleocrMajor: 3 };
  failHealth = false;
  constructor(private readonly truthByImage: Map<string, { date: string; payee: string; total: number }>) {}

  async health(): Promise<SidecarHealth> {
    if (this.failHealth) throw new Error("ECONNREFUSED");
    return this.healthResult;
  }

  async detect(image: Buffer, genome: OcrGenome): Promise<DetectResult> {
    this.calls += 1;
    const truth = this.truthByImage.get(image.toString("utf8"));
    const good = genome.detThresh < 0.35 && truth;
    const lines = good
      ? [
        { polygon: [], bbox: [0, 0, 100, 20] as [number, number, number, number], text: truth.payee, score: 0.9 },
        { polygon: [], bbox: [0, 30, 100, 20] as [number, number, number, number], text: truth.date, score: 0.9 },
        { polygon: [], bbox: [0, 60, 100, 20] as [number, number, number, number], text: "牛乳 220", score: 0.9 },
        { polygon: [], bbox: [0, 90, 100, 20] as [number, number, number, number], text: `合計 ¥${truth.total}`, score: 0.9 },
      ]
      : [{ polygon: [], bbox: [0, 0, 100, 20] as [number, number, number, number], text: "xxxx", score: 0.1 }];
    return { lines, width: 600, height: 1000, elapsedMs: genome.limitSideLen };
  }
}

/** 画像 = image_path 文字列そのもの (偽 sidecar が真値を引くキー) */
function storageFor(truths: Map<string, { date: string; payee: string; total: number }>) {
  return { load: (p: string) => (truths.has(p) ? Buffer.from(p, "utf8") : null) };
}

// ---------------------------------------------------------------------------

describe("corpus-split: receipt id のハッシュで決定的に分ける", () => {
  it("同じ id は常に同じ側、比率はおおむね 20%", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `receipt-${i}`);
    const entries = ids.map((receiptId) => ({ receiptId }));
    const a = splitHoldout(entries);
    const b = splitHoldout([...entries].reverse());
    expect(new Set(a.holdout.map((e) => e.receiptId))).toEqual(new Set(b.holdout.map((e) => e.receiptId)));
    const ratio = a.holdout.length / ids.length;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.25);
    for (const id of ids) expect(isHoldout(id)).toBe(a.holdout.some((e) => e.receiptId === id));
  });

  it("bucket は 0 以上 1 未満で入力に対して安定", () => {
    const v = holdoutBucket("abc");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
    expect(holdoutBucket("abc")).toBe(v);
    expect(holdoutBucket("abd")).not.toBe(v);
  });
});

describe("corpus-builder", () => {
  let db: Database.Database;
  let repo: ReceiptsRepo;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new ReceiptsRepo(db);
  });

  it("サンプルラベル列が無い DB では全件を global として扱う (pending / 画像無しは除外)", () => {
    dropSampleColumns(db);
    seedReceipt(db, repo, "a");
    seedReceipt(db, repo, "b", { status: "manual" });
    seedReceipt(db, repo, "c", { status: "pending" });
    seedReceipt(db, repo, "d", { image: false });
    expect(detectSampleColumns(db)).toEqual({ role: false, tags: false });

    const corpora = buildBenchCorpus(db, { holdoutRatio: 0 });
    expect(corpora.map((c) => c.label)).toEqual(["global"]);
    const ids = corpora[0]!.train.map((e) => e.receiptId).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(corpora[0]!.train[0]!.truth).toEqual({ date: "2026-09-02", payee: "成城石井", total: 1234, items: JSON.stringify([{ name: "牛乳", price: 220 }]) });
  });

  it("列があれば good_sample → global、special_shape → tag:<x>、none は除外、未ラベルは global", () => {
    addSampleColumns(db);
    for (let i = 0; i < 12; i++) { seedReceipt(db, repo, `long${i}`); setSample(db, `long${i}`, "special_shape", ["long"]); }
    for (let i = 0; i < 3; i++) { seedReceipt(db, repo, `faded${i}`); setSample(db, `faded${i}`, "special_shape", ["faded"]); }
    for (let i = 0; i < 5; i++) { seedReceipt(db, repo, `good${i}`); setSample(db, `good${i}`, "good_sample", null); }
    seedReceipt(db, repo, "none0"); setSample(db, "none0", "none", ["long"]);
    seedReceipt(db, repo, "unlabeled0"); setSample(db, "unlabeled0", null, null);
    seedReceipt(db, repo, "both0"); setSample(db, "both0", "special_shape", ["long", "faded"]);
    expect(detectSampleColumns(db)).toEqual({ role: true, tags: true });

    const corpora = buildBenchCorpus(db, { holdoutRatio: 0 });
    expect(corpora.map((c) => c.label)).toEqual(["global", "tag:long"]);
    const global = corpora[0]!.train.map((e) => e.receiptId).sort();
    // good 5 + faded 3 (件数不足で global に畳む) + 未ラベル 1 + both0 (faded 側が畳まれて global にも入る)
    expect(global).toEqual(["both0", "faded0", "faded1", "faded2", "good0", "good1", "good2", "good3", "good4", "unlabeled0"]);
    expect(global).not.toContain("none0");
    const long = corpora[1]!.train.map((e) => e.receiptId);
    expect(long).toHaveLength(13); // long 12 + both0
    expect(long).toContain("both0");
  });

  it("limit は新しい順にラベルごとに効く", () => {
    seedReceipt(db, repo, "old", { capturedAt: 100 });
    seedReceipt(db, repo, "mid", { capturedAt: 200 });
    seedReceipt(db, repo, "new", { capturedAt: 300 });
    const corpora = buildBenchCorpus(db, { limit: 2, holdoutRatio: 0 });
    expect(corpora[0]!.train.map((e) => e.receiptId)).toEqual(["new", "mid"]);
  });

  it("labelsForRow / parseSampleTags: JSON・カンマ区切り・不正タグ", () => {
    const cols = { role: true, tags: true };
    expect(labelsForRow({ sample_role: "special_shape", sample_tags: '["Long","multi column"]' }, cols)).toEqual(["tag:long", "tag:multi_column"]);
    expect(labelsForRow({ sample_role: "special_shape", sample_tags: "long, faded" }, cols)).toEqual(["tag:long", "tag:faded"]);
    expect(labelsForRow({ sample_role: "special_shape", sample_tags: '["!!!"]' }, cols)).toEqual(["global"]);
    expect(labelsForRow({ sample_role: "special_shape", sample_tags: "{broken" }, cols)).toEqual(["global"]);
    expect(labelsForRow({ sample_role: "none", sample_tags: null }, cols)).toBeNull();
    expect(labelsForRow({ sample_role: "good_sample", sample_tags: null }, cols)).toEqual(["global"]);
    expect(labelsForRow({ sample_role: "special_shape", sample_tags: '["long"]' }, { role: false, tags: false })).toEqual(["global"]);
    expect(parseSampleTags("")).toEqual([]);
  });
});

describe("ReceiptStorage corpus boundary", () => {
  it("storage root 外への traversal を拒否する", () => {
    const boundaryRoot = mkdtempSync(join(tmpdir(), "qga-storage-boundary-"));
    try {
      const storage = new ReceiptStorage(join(boundaryRoot, "receipts"));
      expect(storage.load("../outside.jpg")).toBeNull();
      expect(() => storage.resolve("../outside.jpg")).toThrow(/storage root/);
      expect(() => storage.save("../../../outside", Buffer.from("x"))).toThrow(/storage root/);
    } finally {
      rmSync(boundaryRoot, { recursive: true, force: true });
    }
  });
});

describe("evaluator + bench-runner (sidecar モック)", () => {
  let db: Database.Database;
  let repo: ReceiptsRepo;
  let root: string;
  let truths: Map<string, { date: string; payee: string; total: number }>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new ReceiptsRepo(db);
    root = mkdtempSync(join(tmpdir(), "qgabench-"));
    truths = new Map();
    for (let i = 0; i < 6; i++) {
      const id = `r${i}`;
      seedReceipt(db, repo, id, { total: 1000 + i, capturedAt: 1_700_000_000 + i });
      truths.set(`2026/09/${id}.jpg`, { date: "2026-09-02", payee: "成城石井", total: 1000 + i });
    }
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("runGaBench: 1 世代進め、evolution.jsonl と bench-report.json を書く (baseline / holdout / 秒数付き)", async () => {
    const sidecar = new FakeSidecar(truths);
    const gaRoot = join(root, "ga");
    const report = await runGaBench({
      db, storage: storageFor(truths), gaRoot, sidecar,
      labels: ["global"], generations: 1, population: 4, costPerSecond: 0,
      now: (() => { let t = 0; return () => (t += 1000); })(),
    });

    expect(report.device).toBe("cpu");
    expect(report.labels).toHaveLength(1);
    const g = report.labels[0]!;
    expect(g.label).toBe("global");
    expect(g.generation).toBe(1);
    expect(g.population).toBe(4);
    expect(g.corpus.total).toBe(6);
    expect(g.corpus.train + g.corpus.holdout).toBe(6);
    // 既定遺伝子 (第 1 個体) は偽 sidecar で満点 → best も baseline も 1
    expect(g.baseline.fitness).toBe(1);
    expect(g.baseline.fieldHitRate).toEqual({ date: 1, payee: 1, total: 1 });
    expect(g.best.fitness).toBe(1);
    expect(g.best.genome).toEqual(defaultOcrGenome());
    expect(g.mean).toBeLessThanOrEqual(1);
    expect(g.worst).toBeLessThanOrEqual(g.mean);
    if (g.corpus.holdout > 0) {
      expect(g.holdout.best?.fitness).toBe(1);
      expect(g.holdout.baseline?.fitness).toBe(1);
    } else {
      expect(g.holdout.best).toBeNull();
    }
    expect(g.secondsPerIndividual).toBeGreaterThan(0);
    expect(g.totalSeconds).toBeGreaterThan(0);
    expect(g.errors).toBe(0);
    expect(g.reseeded).toBe(false);
    // 既定遺伝子は baseline と個体 1 で同じ → キャッシュされ、detect 回数は個体数 × train 未満
    expect(g.detectCalls).toBe(sidecar.calls);
    expect(sidecar.calls).toBeLessThan((4 + 1) * g.corpus.train + 2 * g.corpus.holdout);

    const log = readFileSync(join(gaRoot, "evolution.jsonl"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    const rec = JSON.parse(log[0]!) as Record<string, unknown>;
    expect(rec.key).toBe("global");
    expect(rec.generation).toBe(1);
    expect(rec.evaluated).toBe(4);
    expect(rec.baselineFitness).toBe(1);
    expect(rec.reseeded).toBe(false);

    const file = readBenchReport(join(gaRoot, "bench-report.json"));
    expect(file?.labels.map((l) => l.label)).toEqual(["global"]);
    expect(file?.sidecarUrl).toBe("http://fake-sidecar");
    expect(existsSync(join(gaRoot, "global.json"))).toBe(true);
    expect(createOcrGaStore(gaRoot).population("global").generation).toBe(1);
  });

  it("runGaBench: ラベル指定なしは全ラベル、report はラベル単位でマージされる", async () => {
    const sidecar = new FakeSidecar(truths);
    const gaRoot = join(root, "ga2");
    const first: BenchReport = {
      ts: "2026-01-01T00:00:00.000Z", sidecarUrl: "old", device: null,
      labels: [{ label: "tag:long" } as LabelBenchReport],
    };
    writeBenchReport(join(gaRoot, "bench-report.json"), first);
    await runGaBench({ db, storage: storageFor(truths), gaRoot, sidecar, generations: 1, population: 2, costPerSecond: 0 });
    const merged = readBenchReport(join(gaRoot, "bench-report.json"));
    expect(merged?.labels.map((l) => l.label)).toEqual(["global", "tag:long"]);
    expect(merged?.sidecarUrl).toBe("http://fake-sidecar");
  });

  it("runGaBench: sidecar 不達 / device 不一致 / 不明ラベルは例外 (黙って縮退しない)", async () => {
    const sidecar = new FakeSidecar(truths);
    const base = { db, storage: storageFor(truths), gaRoot: join(root, "ga3"), sidecar, generations: 1, costPerSecond: 0 };

    sidecar.failHealth = true;
    await expect(runGaBench({ ...base, healthReadiness: { attempts: 1 } })).rejects.toThrow(/unreachable/);
    sidecar.failHealth = false;

    await expect(runGaBench({ ...base, expectedDevice: "gpu" })).rejects.toThrow(/device=gpu but sidecar/);
    await expect(runGaBench({ ...base, labels: ["tag:nope"] })).rejects.toThrow(/label not in corpus: tag:nope/);
    expect(existsSync(join(root, "ga3", "bench-report.json"))).toBe(false);
  });

  it("runGaBench: train 対象が 0 件なら成功 report を作らない", async () => {
    const emptyDb = new Database(":memory:");
    applyMigrations(emptyDb);
    const gaRoot = join(root, "empty");
    await expect(runGaBench({
      db: emptyDb, storage: { load: () => null }, gaRoot,
      sidecar: new FakeSidecar(new Map()), generations: 1, costPerSecond: 0,
    })).rejects.toThrow(/no train entries/);
    expect(existsSync(join(gaRoot, "bench-report.json"))).toBe(false);
    emptyDb.close();
  });

  it("runGaBench: 小さい corpus が全件 holdout になっても成功扱いにしない", async () => {
    const holdoutDb = new Database(":memory:");
    applyMigrations(holdoutDb);
    const holdoutRepo = new ReceiptsRepo(holdoutDb);
    const id = Array.from({ length: 100 }, (_, index) => `holdout-${index}`).find((candidate) => isHoldout(candidate));
    if (!id) throw new Error("test fixture could not find a holdout receipt id");
    seedReceipt(holdoutDb, holdoutRepo, id);
    const imagePath = `2026/09/${id}.jpg`;
    const holdoutTruth = new Map([[imagePath, { date: "2026-09-02", payee: "成城石井", total: 1234 }]]);
    const gaRoot = join(root, "holdout-only");
    await expect(runGaBench({
      db: holdoutDb, storage: storageFor(holdoutTruth), gaRoot,
      sidecar: new FakeSidecar(holdoutTruth), generations: 1, costPerSecond: 0,
    })).rejects.toThrow(/no train entries/);
    expect(existsSync(join(gaRoot, "bench-report.json"))).toBe(false);
    holdoutDb.close();
  });

  it("evaluator: 画像欠損 / detect 失敗は 0 点 + errors、全滅なら世代を進めず例外", async () => {
    const sidecar = new FakeSidecar(truths);
    const ga = createOcrGaStore(join(root, "ga4"));
    const evaluator = new OcrGaBenchEvaluator({ ga, sidecar, loadImage: () => null, costPerSecond: 0 });
    const corpus = buildBenchCorpus(db, { holdoutRatio: 0 })[0]!;
    await expect(evaluator.runLabel(corpus, { generations: 1 })).rejects.toThrow(/failed for every train image/);
    expect(ga.population("global").generation).toBe(0);

    // 一部だけ欠損: 欠損分は 0 点、残りで平均
    const partial = new OcrGaBenchEvaluator({
      ga, sidecar, costPerSecond: 0,
      loadImage: (p) => (p.includes("r0") ? null : Buffer.from(p, "utf8")),
    });
    const score = await partial.scoreGenome(defaultOcrGenome(), corpus.train);
    expect(score.errors).toBe(1);
    expect(score.evaluated).toBe(6);
    expect(score.fitness).toBeCloseTo(5 / 6, 3);
    expect(score.fieldHitRate.total).toBeCloseTo(5 / 6, 3);
  });

  it("evaluator: 空の train / 世代数 0 は例外、コスト項が fitness に効く", async () => {
    const sidecar = new FakeSidecar(truths);
    const ga = createOcrGaStore(join(root, "ga5"));
    const evaluator = new OcrGaBenchEvaluator({ ga, sidecar, loadImage: storageFor(truths).load, costPerSecond: 0.0001 });
    await expect(evaluator.runLabel({ label: "global", train: [], holdout: [] }, { generations: 1 })).rejects.toThrow(/train corpus is empty/);
    const corpus = buildBenchCorpus(db, { holdoutRatio: 0 })[0]!;
    await expect(evaluator.runLabel(corpus, { generations: 0 })).rejects.toThrow(/positive integer/);
    // 既定遺伝子は limitSideLen 960 → 0.96 秒 × 0.0001 = 0.000096 のペナルティ
    const s = await evaluator.scoreGenome(defaultOcrGenome(), corpus.train);
    expect(s.fitness).toBeLessThan(1);
    expect(s.fitness).toBeGreaterThan(0.99);
    expect(s.meanElapsedMs).toBe(960);
  });

  it("evaluator: field hit rate は真値があるレシートだけを分母にする", async () => {
    const sidecar = new FakeSidecar(truths);
    const evaluator = new OcrGaBenchEvaluator({
      ga: createOcrGaStore(join(root, "field-rate")), sidecar,
      loadImage: storageFor(truths).load, costPerSecond: 0,
    });
    const corpus = buildBenchCorpus(db, { holdoutRatio: 0 })[0]!;
    const entries = corpus.train.slice(0, 2).map((entry, index) => ({
      ...entry,
      truth: { ...entry.truth, payee: index === 0 ? entry.truth.payee : null },
    }));
    const score = await evaluator.scoreGenome(defaultOcrGenome(), entries);
    expect(score.fieldHitRate.payee).toBe(1);
    expect(score.fieldHitRate.date).toBe(1);
  });

  it("evaluator: 評価中に世代が進んだ場合は stale な結果を記録しない", async () => {
    let unblock: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const detected = new Promise<void>((resolve) => { started = resolve; });
    const delegate = new FakeSidecar(truths);
    const blocked: OcrSidecarClient = {
      baseUrl: delegate.baseUrl,
      health: () => delegate.health(),
      detect: async (image, genome) => {
        started();
        await gate;
        return delegate.detect(image, genome);
      },
    };
    const gaRoot = join(root, "stale");
    const ga = createOcrGaStore(gaRoot);
    const evaluator = new OcrGaBenchEvaluator({ ga, sidecar: blocked, loadImage: storageFor(truths).load, costPerSecond: 0 });
    const corpus = buildBenchCorpus(db, { holdoutRatio: 0 })[0]!;
    const pending = evaluator.runLabel(corpus, { generations: 1, population: 1 });
    await detected;

    const concurrent = createOcrGaStore(gaRoot);
    const pop = concurrent.population("global");
    concurrent.recordGeneration("global", [{ genome: pop.genomes[0]!, fitness: 0.5 }], { expectedGeneration: pop.generation });
    unblock();

    await expect(pending).rejects.toThrow(/stale GA generation/);
    expect(ga.population("global").generation).toBe(1);
  });

  it("genomeCacheKey は sidecar と同じ丸めで同一視する", () => {
    const a = { ...defaultOcrGenome(), detThresh: 0.30001 };
    expect(genomeCacheKey(a)).toBe(genomeCacheKey(defaultOcrGenome()));
    expect(genomeCacheKey({ ...defaultOcrGenome(), useDilation: true })).not.toBe(genomeCacheKey(defaultOcrGenome()));
  });

  it("mergeBenchReport: 走らせなかったラベルは前回を残し、同じラベルは上書き", () => {
    const prev: BenchReport = { ts: "1", sidecarUrl: "a", device: null, labels: [{ label: "global", generation: 1 } as LabelBenchReport, { label: "tag:x", generation: 3 } as LabelBenchReport] };
    const next: BenchReport = { ts: "2", sidecarUrl: "b", device: "gpu", labels: [{ label: "global", generation: 2 } as LabelBenchReport] };
    const m = mergeBenchReport(prev, next);
    expect(m.ts).toBe("2");
    expect(m.device).toBe("gpu");
    expect(m.labels.map((l) => [l.label, l.generation])).toEqual([["global", 2], ["tag:x", 3]]);
    expect(mergeBenchReport(null, next).labels).toHaveLength(1);
  });
});
