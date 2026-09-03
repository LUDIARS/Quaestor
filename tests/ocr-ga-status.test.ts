/**
 * B-5「OCR 進化」カードの backend 側 — `GET /v1/ocr-ga/status` と警告条件。
 *
 * 主目的は「測定系が死んでいる」ことが値として出ること: bench-report.json が無い /
 * sidecar 不達 / 評価 0 件 / 最終評価が 48 時間以上前。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrGaRouter } from "../src/api/ocr-ga.js";
import { configRouter } from "../src/api/config.js";
import { loadAppConfig, type AppConfig } from "../src/services/app-config.js";
import { createOcrGaStore, defaultOcrGenome } from "../src/services/ocr-ga.js";
import { computeGaStatusWarnings, STALE_EVALUATION_MS } from "../src/services/ocr-ga-bench/status-warnings.js";
import type { OcrGaStatus } from "../src/services/ocr-ga-bench/status-types.js";
import type { SidecarHealth } from "../src/services/ocr-sidecar-client.js";
import type { BenchReport } from "../src/services/ocr-ga-bench/types.js";

const REPORT_TS = "2026-09-03T03:40:00.000Z";
/** 最終評価の 1 時間後 = 48 時間以内なので陳腐化の警告は出ない時刻 */
const FRESH_NOW = Date.parse(REPORT_TS) + 3_600_000;

const HEALTHY: SidecarHealth = {
  ok: true, model: "PP-OCRv5", device: "gpu", requestedDevice: "gpu", deviceError: null, paddleocrMajor: 3,
};

function benchReport(overrides: Partial<BenchReport["labels"][number]> = {}): BenchReport {
  const score = { fitness: 0.62, fieldHitRate: { date: 0.8, payee: 0.5, total: 0.7 } };
  return {
    ts: REPORT_TS,
    sidecarUrl: "http://127.0.0.1:17351",
    device: "gpu",
    labels: [{
      label: "global",
      corpus: { train: 40, holdout: 10, total: 50 },
      generation: 3,
      generationsRun: 1,
      population: 8,
      best: { ...score, genome: defaultOcrGenome() },
      mean: 0.55,
      worst: 0.41,
      baseline: { fitness: 0.58, fieldHitRate: { date: 0.75, payee: 0.45, total: 0.65 } },
      holdout: { best: score, baseline: { fitness: 0.57, fieldHitRate: { date: 0.7, payee: 0.4, total: 0.6 } } },
      secondsPerIndividual: 42.5,
      totalSeconds: 900,
      detectCalls: 358,
      errors: 0,
      reseeded: false,
      ts: REPORT_TS,
      ...overrides,
    }],
  };
}

function evolutionLine(generation: number, best: number, baseline: number | null): string {
  return JSON.stringify({
    ts: REPORT_TS, key: "global", generation, evaluated: 8,
    bestFitness: best, meanFitness: best - 0.05, worstFitness: best - 0.1,
    bestGenome: defaultOcrGenome(), baselineFitness: baseline, reseeded: false,
  });
}

function productionLine(fitness: number, baselineFitness: number | null): string {
  return JSON.stringify({
    receiptId: "11111111-2222-3333-4444-555555555555",
    label: "global", tags: [], generation: 0, genome: defaultOcrGenome(),
    fitness, fieldHits: { date: true, payee: true, total: false },
    baselineFitness, elapsedMs: 101_664, ts: REPORT_TS,
  });
}

describe("GET /v1/ocr-ga/status", () => {
  let root: string;
  let gaRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qgastatus-"));
    gaRoot = join(root, "ga");
    mkdirSync(gaRoot, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function config(): AppConfig {
    // 既定値 (ファイル無し) を土台に gaRoot だけ temp に向ける
    const base = loadAppConfig(join(root, "no-such-config.json"));
    return { ...base, training: { ...base.training, gaRoot } };
  }

  function router(health: () => Promise<SidecarHealth>, now = FRESH_NOW) {
    return ocrGaRouter({
      ga: createOcrGaStore(gaRoot),
      gaRoot,
      loadConfig: config,
      sidecarFor: (url) => ({ baseUrl: url, health }),
      now: () => now,
      canReadStatus: () => true,
    });
  }

  async function status(health: () => Promise<SidecarHealth>, now = FRESH_NOW): Promise<{ res: Response; body: OcrGaStatus }> {
    const res = await router(health, now).request("/status");
    return { res, body: await res.json() as OcrGaStatus };
  }

  it("正常: report・evolution・production が揃っていれば警告なしで値を返す", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify(benchReport()), "utf8");
    writeFileSync(join(gaRoot, "evolution.jsonl"),
      [evolutionLine(1, 0.5, 0.58), evolutionLine(2, 0.6, 0.58), evolutionLine(3, 0.62, 0.58)].join("\n") + "\n", "utf8");
    writeFileSync(join(gaRoot, "production-eval.jsonl"),
      [productionLine(0.8, 0.7), productionLine(0.9, null)].join("\n") + "\n", "utf8");

    const { res, body } = await status(async () => HEALTHY);
    expect(res.status).toBe(200);
    expect(body.warnings).toEqual([]);
    expect(body.bench).toEqual({ ts: REPORT_TS, sidecarUrl: "http://127.0.0.1:17351", device: "gpu" });
    expect(body.sidecar).toMatchObject({ reachable: true, ok: true, device: "gpu", error: null });
    expect(body.config).toMatchObject({ enabled: false, hour: 3, device: "cpu" });
    expect("gaRoot" in body).toBe(false);

    expect(body.labels).toHaveLength(1);
    const label = body.labels[0]!;
    expect(label.label).toBe("global");
    expect(label.bench).toMatchObject({ generation: 3, mean: 0.55, secondsPerIndividual: 42.5 });
    expect(label.bench?.baseline.fitness).toBe(0.58);
    expect(label.bench?.holdout.best?.fitness).toBe(0.62);
    // best.genome は observability に不要なので載せない (型にも無い)
    expect(label.bench?.best).toEqual({ fitness: 0.62, fieldHitRate: { date: 0.8, payee: 0.5, total: 0.7 } });
    expect(label.trend.map((p) => p.generation)).toEqual([1, 2, 3]);
    expect(label.trend.map((p) => p.best)).toEqual([0.5, 0.6, 0.62]);
    expect(label.trend.every((p) => p.baseline === 0.58)).toBe(true);

    expect(body.production).toMatchObject({
      count: 2, window: 20, meanFitness: 0.85, baselineSamples: 1, meanBaselineFitness: 0.7,
      baselineDelta: 0.15, meanFieldHits: { date: 1, payee: 1, total: 0 },
    });
  });

  it("report 無し: 500 にせず bench:null と bench_report_missing 警告を返す", async () => {
    const { res, body } = await status(async () => HEALTHY);
    expect(res.status).toBe(200);
    expect(body.bench).toBeNull();
    expect(body.labels).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toEqual(["bench_report_missing"]);
    // report が無いだけで sidecar は生きている
    expect(body.sidecar.reachable).toBe(true);
  });

  it("sidecar 不達: 500 にせず reachable:false と理由、sidecar_unreachable 警告を返す", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify(benchReport()), "utf8");

    const { res, body } = await status(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:17351"); });
    expect(res.status).toBe(200);
    expect(body.sidecar).toMatchObject({ reachable: false, ok: false, device: null });
    expect(body.sidecar.error).toBe("sidecar health request failed");
    expect(body.warnings.map((w) => w.code)).toEqual(["sidecar_unreachable"]);
    expect(body.warnings[0]!.message).not.toContain("127.0.0.1");
  });

  it("production-eval.jsonl が無ければ production キーごと出さない (0 埋めしない)", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify(benchReport()), "utf8");

    const { body } = await status(async () => HEALTHY);
    expect("production" in body).toBe(false);
    expect(body.production).toBeUndefined();
  });

  it("最終評価が 48 時間以上前なら stale_evaluation 警告が出る", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify(benchReport()), "utf8");

    const { body } = await status(async () => HEALTHY, Date.parse(REPORT_TS) + STALE_EVALUATION_MS + 1);
    expect(body.warnings.map((w) => w.code)).toEqual(["stale_evaluation"]);
  });

  it("report はあるがコーパスが空なら no_evaluations 警告が出る", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"),
      JSON.stringify(benchReport({ corpus: { train: 0, holdout: 0, total: 0 } })), "utf8");

    const { body } = await status(async () => HEALTHY);
    expect(body.warnings.map((w) => w.code)).toEqual(["no_evaluations"]);
  });

  it("sidecar が ok:false を返したら不達扱いで警告を出す", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify(benchReport()), "utf8");

    const { body } = await status(async () => ({ ...HEALTHY, ok: false }));
    expect(body.sidecar).toMatchObject({ reachable: true, ok: false });
    expect(body.warnings.map((w) => w.code)).toEqual(["sidecar_unreachable"]);
  });

  it("bench-report に無く evolution.jsonl にだけ居るラベルも行として残す", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify(benchReport()), "utf8");
    writeFileSync(join(gaRoot, "evolution.jsonl"),
      JSON.stringify({ ts: REPORT_TS, key: "tag:long", generation: 1, evaluated: 8, bestFitness: 0.4, meanFitness: 0.3, worstFitness: 0.2, baselineFitness: 0.45, reseeded: true }) + "\n", "utf8");

    const { body } = await status(async () => HEALTHY);
    expect(body.labels.map((l) => l.label)).toEqual(["global", "tag:long"]);
    const tagged = body.labels[1]!;
    expect(tagged.bench).toBeNull();
    expect(tagged.trend[0]).toMatchObject({ generation: 1, best: 0.4, baseline: 0.45, reseeded: true });
  });

  it("壊れた行 / 壊れた report は落とさず読めるところだけ返す", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), "{ not json", "utf8");
    writeFileSync(join(gaRoot, "evolution.jsonl"), `{ broken\n${evolutionLine(1, 0.5, 0.5)}\n\n`, "utf8");

    const { res, body } = await status(async () => HEALTHY);
    expect(res.status).toBe(200);
    expect(body.bench).toBeNull();
    expect(body.labels[0]!.trend).toHaveLength(1);
  });

  it("構造が壊れた report のラベルは捨て、status 自体は返す", async () => {
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify({
      ts: REPORT_TS,
      labels: [null, { label: "global" }],
    }), "utf8");

    const { res, body } = await status(async () => HEALTHY);
    expect(res.status).toBe(200);
    expect(body.labels).toEqual([]);
    expect(body.warnings.map((warning) => warning.code)).toEqual(["no_evaluations"]);
  });

  it("旧店舗キーと report 内の余分なプロパティを応答へ出さない", async () => {
    const report = benchReport();
    (report.labels[0]!.baseline as BenchReport["labels"][number]["baseline"] & { receiptId: string }).receiptId = "private";
    report.labels.push({ ...report.labels[0]!, label: "旧店舗名" });
    writeFileSync(join(gaRoot, "bench-report.json"), JSON.stringify(report), "utf8");
    writeFileSync(join(gaRoot, "evolution.jsonl"), JSON.stringify({
      key: "旧店舗名", generation: 1, bestFitness: 0.4,
    }) + "\n", "utf8");

    const { body } = await status(async () => HEALTHY);
    expect(body.labels.map((label) => label.label)).toEqual(["global"]);
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain("旧店舗名");
  });

  it("loopback 以外から status を読めない", async () => {
    const res = await ocrGaRouter({
      ga: createOcrGaStore(gaRoot),
      canReadStatus: () => false,
    }).request("/status");

    expect(res.status).toBe(403);
  });

  it("不正な sidecar URL は 500 や credential 漏洩にせず不達として返す", async () => {
    const configured = config();
    configured.training.gaBench.sidecarUrl = "http://user:password@127.0.0.1:17351";
    const app = ocrGaRouter({
      ga: createOcrGaStore(gaRoot),
      gaRoot,
      loadConfig: () => configured,
      canReadStatus: () => true,
      now: () => FRESH_NOW,
    });

    const res = await app.request("/status");
    const responseText = await res.text();
    expect(res.status).toBe(200);
    expect(responseText).not.toContain("user");
    expect(responseText).not.toContain("password");
    expect((JSON.parse(responseText) as OcrGaStatus).sidecar.reachable).toBe(false);
  });
});

describe("警告条件 (computeGaStatusWarnings)", () => {
  const base = {
    now: FRESH_NOW,
    benchReportPresent: true,
    benchReportTs: REPORT_TS,
    evaluatedLabels: 1,
    sidecarHealthy: true,
    sidecarDetail: null,
  };

  it("すべて健全なら警告なし", () => {
    expect(computeGaStatusWarnings(base)).toEqual([]);
  });

  it("report が無ければ bench_report_missing。評価 0 件とは二重に出さない", () => {
    const warnings = computeGaStatusWarnings({ ...base, benchReportPresent: false, benchReportTs: null, evaluatedLabels: 0 });
    expect(warnings.map((w) => w.code)).toEqual(["bench_report_missing"]);
  });

  it("report があって評価ラベルが 0 なら no_evaluations", () => {
    expect(computeGaStatusWarnings({ ...base, evaluatedLabels: 0 }).map((w) => w.code)).toEqual(["no_evaluations"]);
  });

  it("最終評価が 48 時間以上前なら stale_evaluation (48 時間ちょうどで出る)", () => {
    const justUnder = { ...base, now: Date.parse(REPORT_TS) + STALE_EVALUATION_MS - 1 };
    expect(computeGaStatusWarnings(justUnder)).toEqual([]);
    const exactly = { ...base, now: Date.parse(REPORT_TS) + STALE_EVALUATION_MS };
    expect(computeGaStatusWarnings(exactly).map((w) => w.code)).toEqual(["stale_evaluation"]);
  });

  it("staleAfterMs は差し替えられる", () => {
    const warnings = computeGaStatusWarnings({ ...base, now: Date.parse(REPORT_TS) + 7_200_000, staleAfterMs: 3_600_000 });
    expect(warnings.map((w) => w.code)).toEqual(["stale_evaluation"]);
  });

  it("sidecar 不達は理由をメッセージに添える", () => {
    const warnings = computeGaStatusWarnings({ ...base, sidecarHealthy: false, sidecarDetail: "ECONNREFUSED" });
    expect(warnings.map((w) => w.code)).toEqual(["sidecar_unreachable"]);
    expect(warnings[0]!.message).toContain("ECONNREFUSED");
  });

  it("複数の警告は report 欠落 → 陳腐化 → sidecar の順で並ぶ", () => {
    const warnings = computeGaStatusWarnings({
      ...base,
      benchReportPresent: false,
      benchReportTs: null,
      evaluatedLabels: 0,
      sidecarHealthy: false,
      sidecarDetail: null,
    });
    expect(warnings.map((w) => w.code)).toEqual(["bench_report_missing", "sidecar_unreachable"]);
  });

  it("ts が壊れていれば陳腐化は判定しない (勝手に古いことにしない)", () => {
    expect(computeGaStatusWarnings({ ...base, benchReportTs: "not-a-date" })).toEqual([]);
  });
});

describe("PUT /v1/config/ga-bench (夜間ジョブの on/off)", () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qgacfg-"));
    configPath = join(root, "quaestor.config.json");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("enabled を書き戻し、$comment や他のキーを消さない", async () => {
    writeFileSync(configPath, JSON.stringify({
      server: { port: 17400 },
      training: {
        gaRoot: "app_data/training/ga",
        gaBench: { $comment: "残すべきコメント", enabled: false, hour: 3, device: "cpu" },
      },
    }, null, 2), "utf8");

    const app = configRouter(configPath, () => true);
    expect(await (await app.request("/ga-bench")).json()).toEqual({ enabled: false });

    const res = await app.request("/ga-bench", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; note: string };
    expect(body.enabled).toBe(true);
    expect(body.note).toContain("再起動");

    const written = loadAppConfig(configPath);
    expect(written.training.gaBench.enabled).toBe(true);
    expect(written.training.gaBench.hour).toBe(3);
    expect(written.server.port).toBe(17400);
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { training: { gaBench: Record<string, unknown> } };
    expect(raw.training.gaBench.$comment).toBe("残すべきコメント");
  });

  it("boolean 以外は 400", async () => {
    writeFileSync(configPath, JSON.stringify({ training: { gaBench: { enabled: false } } }), "utf8");
    const res = await configRouter(configPath, () => true).request("/ga-bench", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(loadAppConfig(configPath).training.gaBench.enabled).toBe(false);
  });

  it("壊れた設定は上書きせず 409 を返す", async () => {
    const malformed = `{ "server": { "port": 17400 },`;
    writeFileSync(configPath, malformed, "utf8");

    const res = await configRouter(configPath, () => true).request("/ga-bench", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(409);
    expect(readFileSync(configPath, "utf8")).toBe(malformed);
  });

  it("loopback 以外からの設定変更は拒否する", async () => {
    writeFileSync(configPath, JSON.stringify({ training: { gaBench: { enabled: false } } }), "utf8");

    const res = await configRouter(configPath, () => false).request("/ga-bench", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(403);
    expect(loadAppConfig(configPath).training.gaBench.enabled).toBe(false);
  });
});
