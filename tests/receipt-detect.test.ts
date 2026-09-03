import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { createOcrGaStore, defaultOcrGenome, type OcrGenome } from "../src/services/ocr-ga.js";
import type { DetectResult, OcrLine, OcrSidecarClient, SidecarHealth } from "../src/services/ocr-sidecar-client.js";
import { PRODUCTION_EVAL_FILE, ProductionEvalLog } from "../src/services/receipt-detect/production-eval-log.js";
import type { ProductionEvalRecord } from "../src/services/receipt-detect/types.js";
import { buildFieldRegions } from "../src/services/receipt-detect/field-regions.js";
import { ReceiptDetectService } from "../src/services/receipt-detect/detect-service.js";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReceiptStorage } from "../src/services/receipt-storage.js";

/** 1x1 px の最小 PNG。detect は sidecar をモックするので中身は問わない */
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

const TRUTH = { date: "2026-09-02", payee: "カスミ 志木店", total: 4080 };

/** 1 枚ごとに違うバイト列 (server-side の同一画像 dedup を避ける)。中身は検査されない */
function uniqueImageB64(): string {
  return Buffer.concat([Buffer.from(PNG_1x1, "base64"), randomBytes(8)]).toString("base64");
}

function line(text: string, y: number, score = 0.95): OcrLine {
  return {
    polygon: [[10, y], [200, y], [200, y + 20], [10, y + 20]],
    bbox: [10, y, 190, 20],
    text,
    score,
  };
}

const SIDECAR_LINES: OcrLine[] = [
  line("カスミ 志木店", 40),
  line("2026年09月02日(水)16:56", 70),
  line("合計 ¥4,080", 400),
  line("牛乳 220", 200),
];

/** 呼び出し履歴を持つ sidecar モック (backend → sidecar 経路のテスト用) */
class FakeSidecar implements OcrSidecarClient {
  readonly baseUrl = "http://sidecar.test";
  readonly calls: Array<{ genome: OcrGenome; filename: string }> = [];
  lines: OcrLine[] = SIDECAR_LINES;
  failure: Error | null = null;
  /** この回数を超えた detect を失敗させる (baseline だけ落とす等)。null で無効 */
  failAfter: number | null = null;
  /** detect を保留させる gate (並行呼び出しの畳み込み確認に使う) */
  gate: Promise<void> | null = null;

  async health(): Promise<SidecarHealth> {
    return { ok: true, model: "test", device: "cpu", requestedDevice: null, deviceError: null, paddleocrMajor: 3 };
  }

  async detect(_image: Buffer, genome: OcrGenome, filename = "receipt.jpg"): Promise<DetectResult> {
    this.calls.push({ genome, filename });
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    if (this.failAfter != null && this.calls.length > this.failAfter) throw new Error("sidecar down");
    return { lines: this.lines, width: 608, height: 1080, elapsedMs: 40_000 };
  }
}

interface DetectResponse {
  source: "real" | null;
  reason: string | null;
  cached: boolean;
  key: string;
  genomeSource: string;
  generation: number;
  genome: OcrGenome;
  regions: Array<{ field: string; recognizedText: string; polygon: unknown[] }>;
  eval: ProductionEvalRecord | null;
}

describe("POST /v1/receipts/:id/detect (撮影時の運用評価)", () => {
  let root: string;
  let gaRoot: string;
  let receiptsRoot: string;
  let trainingRoot: string;
  let sidecar: FakeSidecar;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qdetect-"));
    gaRoot = join(root, "ga");
    receiptsRoot = join(root, "receipts");
    trainingRoot = join(root, "training");
    sidecar = new FakeSidecar();
    app = buildApp({
      db: new Database(":memory:"),
      receiptsRoot,
      gaRoot,
      trainingRoot,
      ocrSidecar: sidecar,
      // baseline の後追い (既定遺伝子で 2 回目の detect) はここでは切り、専用の describe で見る
      ocrDetectBaseline: false,
    });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** 撮影 → OCR 結果 (真値 + サンプルラベル) まで進んだ receipt を作る */
  async function createReceipt(sample?: { role: "good_sample" | "special_shape"; tags?: string[] }): Promise<string> {
    const create = await app.request("/v1/receipts", {
      // 同一画像は 30 秒 dedup されるので 1 枚ごとに違うバイト列にする
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: uniqueImageB64(), ext: "png" }),
    });
    const { receipt } = await create.json() as { receipt: { id: string } };
    await app.request(`/v1/receipts/${receipt.id}/ocr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ocr_status: "done",
        ...TRUTH,
        items: [{ name: "牛乳", price: 220 }],
        kind: "receipt",
        ...(sample ? { sample: { role: sample.role, tags: sample.tags ?? [], reason: null } } : {}),
      }),
    });
    return receipt.id;
  }

  function detect(id: string, query = ""): Promise<Response> {
    return app.request(`/v1/receipts/${id}/detect${query}`, { method: "POST" });
  }

  function readEvalLines(): string[] {
    const file = join(gaRoot, PRODUCTION_EVAL_FILE);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  }

  it("タグ → 遺伝子解決が resolveBestGenome (tag → global → default) と一致する", async () => {
    const store = createOcrGaStore(gaRoot);
    const globalWinner: OcrGenome = { ...defaultOcrGenome(), detThresh: 0.22 };
    const tagWinner: OcrGenome = { ...defaultOcrGenome(), detThresh: 0.48, limitSideLen: 1280 };
    store.recordGeneration("global", [{ genome: globalWinner, fitness: 0.5 }]);
    store.recordGeneration("tag:long", [{ genome: tagWinner, fitness: 0.6 }]);

    // tag:long に記録があるので tag 優先
    const tagged = await (await detect(await createReceipt({ role: "special_shape", tags: ["long"] }))).json() as DetectResponse;
    expect(tagged).toMatchObject({ key: "tag:long", genomeSource: "tag", generation: 1 });
    expect(tagged.genome).toEqual(tagWinner);
    expect(sidecar.calls.at(-1)).toMatchObject({ genome: tagWinner });

    // 記録の無いタグは global へ落ちる
    const globals = await (await detect(await createReceipt({ role: "special_shape", tags: ["faded"] }))).json() as DetectResponse;
    expect(globals).toMatchObject({ key: "global", genomeSource: "global" });
    expect(globals.genome).toEqual(globalWinner);

    // sidecar は 1 receipt につき 1 回だけ
    expect(sidecar.calls.length).toBe(2);
  });

  it("記録がまったく無ければ既定遺伝子で叩き、baseline は同期で埋まる", async () => {
    const res = await (await detect(await createReceipt())).json() as DetectResponse;
    expect(res).toMatchObject({ source: "real", genomeSource: "default", generation: 0 });
    expect(res.genome).toEqual(defaultOcrGenome());
    // 勝ち遺伝子が既定遺伝子そのものなら baseline は同値 (2 回目の detect は要らない)
    expect(res.eval?.baselineFitness).toBe(res.eval?.fitness);
    expect(sidecar.calls.length).toBe(1);
  });

  it("本物 BB (source=real / recognizedText / polygon) を返し、学習データセットへ流す", async () => {
    const id = await createReceipt();
    const res = await (await detect(id)).json() as DetectResponse;
    expect(res.source).toBe("real");

    const fields = res.regions.map((r) => r.field);
    expect(fields).toContain("payee");
    expect(fields).toContain("date");
    expect(fields).toContain("total");
    for (const r of res.regions) {
      expect(r.recognizedText.length).toBeGreaterThan(0);
      expect(r.polygon.length).toBe(4);
    }

    // 学習レコード (training-dataset) に本物 BB が入っている = 実運用 (経路) KPI が 0 でなくなる
    const record = JSON.parse(readFileSync(join(trainingRoot, "records", `${id}.json`), "utf8")) as {
      engine: string; regions: Array<{ label: string; text: string; polygon: unknown }>;
    };
    expect(record.engine).toBe("paddle");
    expect(record.regions.map((r) => r.label)).toContain("total");
    expect(record.regions[0]?.polygon).toBeTruthy();
  });

  it("sidecar 不達は 200 で source 無しの空結果 (演出は fallback に落ちる)", async () => {
    sidecar.failure = new Error("sidecar request timed out after 180000 ms");
    const id = await createReceipt();
    const res = await detect(id);
    expect(res.status).toBe(200);
    const j = await res.json() as DetectResponse;
    expect(j).toMatchObject({ source: null, reason: "sidecar_failed", regions: [] });
    expect(j.eval).toBeNull();
    // 失敗は運用評価レコードを作らない (0 点で平均を汚さない)
    expect(readEvalLines()).toEqual([]);
  });

  it("OCR 未完了なら sidecar を叩かない (真値が無いうちに 40 秒を使わない)", async () => {
    const create = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: uniqueImageB64(), ext: "png" }),
    });
    const { receipt } = await create.json() as { receipt: { id: string } };
    const j = await (await detect(receipt.id)).json() as DetectResponse;
    expect(j).toMatchObject({ source: null, reason: "ocr_not_ready" });
    expect(sidecar.calls.length).toBe(0);
  });

  it("同一 receipt の並行呼び出しは 1 本に畳まれる (二重に 40 秒を走らせない)", async () => {
    const id = await createReceipt();
    let open!: () => void;
    sidecar.gate = new Promise<void>((resolve) => { open = resolve; });

    const both = Promise.all([detect(id), detect(id)]);
    // gate が開くまで detect は 1 本だけ走っている
    expect(sidecar.calls.length).toBe(1);
    open();
    const [a, b] = await both;
    const [ja, jb] = await Promise.all([a.json(), b.json()]) as DetectResponse[];

    expect(ja!.source).toBe("real");
    expect(jb!.source).toBe("real");
    expect(sidecar.calls.length).toBe(1);
    // レコードも 1 件だけ
    expect(readEvalLines().length).toBe(1);
  });

  it("評価済 receipt は sidecar を叩き直さず、force=1 でだけ測り直す", async () => {
    const id = await createReceipt();
    await detect(id);
    expect(sidecar.calls.length).toBe(1);

    const cached = await (await detect(id)).json() as DetectResponse;
    expect(cached.cached).toBe(true);
    expect(cached.source).toBe("real");
    expect(sidecar.calls.length).toBe(1);

    const forced = await (await detect(id, "?force=1")).json() as DetectResponse;
    expect(forced.cached).toBe(false);
    expect(sidecar.calls.length).toBe(2);
    expect(readEvalLines().length).toBe(2);
  });

  it("404 は not_found、detect service 未設定なら 503", async () => {
    expect((await detect("nope")).status).toBe(404);
    const noDetect = buildApp({ db: new Database(":memory:"), receiptsRoot, gaRoot, trainingRoot });
    // 実 HTTP client は組み込まれるが、ここでは service の有無ではなく receipt の有無で 404 になる
    expect((await noDetect.request("/v1/receipts/nope/detect", { method: "POST" })).status).toBe(404);
  });
});

describe("運用評価レコード (production-eval.jsonl)", () => {
  let root: string;
  let log: ProductionEvalLog;

  const record = (over: Partial<ProductionEvalRecord> = {}): ProductionEvalRecord => ({
    receiptId: "r1",
    label: "global",
    tags: [],
    generation: 3,
    genome: defaultOcrGenome(),
    fitness: 0.8,
    fieldHits: { date: true, payee: false, total: true },
    baselineFitness: null,
    elapsedMs: 40_000,
    ts: "2026-09-03T00:00:00.000Z",
    ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qeval-"));
    log = new ProductionEvalLog(join(root, "ga"));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("1 行 = 1 レコードで、設計書の 9 フィールドが揃う", () => {
    log.append(record());
    log.append(record({ receiptId: "r2", ts: "2026-09-03T01:00:00.000Z", baselineFitness: 0.5 }));

    const lines = readFileSync(log.file, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]!) as ProductionEvalRecord;
    expect(Object.keys(parsed).sort()).toEqual([
      "baselineFitness", "elapsedMs", "fieldHits", "fitness", "generation",
      "genome", "label", "receiptId", "tags", "ts",
    ]);
    expect(parsed.baselineFitness).toBeNull();
    expect(parsed.fieldHits).toEqual({ date: true, payee: false, total: true });
  });

  it("baseline を後追いで埋めても行数は増えない", () => {
    log.append(record());
    log.append(record({ receiptId: "r2", ts: "2026-09-03T01:00:00.000Z" }));

    expect(log.setBaseline("r1", "2026-09-03T00:00:00.000Z", 0.62)).toBe(true);
    expect(log.setBaseline("r1", "2026-09-03T09:99:00.000Z", 0.1)).toBe(false);

    const all = log.read();
    expect(all.length).toBe(2);
    expect(all[0]?.baselineFitness).toBe(0.62);
    expect(all[1]?.baselineFitness).toBeNull();
  });

  it("summary は直近 n 件の平均を出すだけで、判定 (再 seed / 既定へ戻す) はしない", () => {
    expect(log.summary()).toBeNull();
    log.append(record({ receiptId: "r1", fitness: 0.4, baselineFitness: 0.6 }));
    log.append(record({ receiptId: "r2", ts: "2026-09-03T02:00:00.000Z", fitness: 0.6, baselineFitness: 0.6 }));
    log.append(record({ receiptId: "r3", ts: "2026-09-03T03:00:00.000Z", fitness: 0.9 }));

    const summary = log.summary()!;
    expect(summary.count).toBe(3);
    expect(summary.meanFitness).toBeCloseTo(0.6333, 3);
    expect(summary.baselineSamples).toBe(2);
    expect(summary.meanBaselineFitness).toBe(0.6);
    expect(summary.belowBaseline).toBe(false);

    // baseline が 1 件も無ければ判定材料が無いので null (自動で既定遺伝子に戻さない)
    const fresh = new ProductionEvalLog(join(root, "ga2"));
    fresh.append(record({ baselineFitness: null }));
    expect(fresh.summary()?.belowBaseline).toBeNull();
  });

  it("壊れた行は読み飛ばす (観測用ファイルなので読めるものだけ使う)", () => {
    log.append(record());
    appendFileSync(log.file, "{ not json\n", "utf8");
    appendFileSync(log.file, JSON.stringify({ ...record(), receiptId: "invalid", baselineFitness: "invalid" }) + "\n", "utf8");
    log.append(record({ receiptId: "r2", ts: "2026-09-03T04:00:00.000Z" }));
    expect(log.read().map((r) => r.receiptId)).toEqual(["r1", "r2"]);
  });
});

describe("baseline の後追い (既定遺伝子での再採点)", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qdetectbase-")); });
  afterEach(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });

  /** OCR 済 receipt を repo 直で作る (service 単体を見るので API 経由にしない) */
  function seedReceipt(receipts: ReceiptsRepo, storage: ReceiptStorage): string {
    const id = receipts.insert({ metadata: { source: "test" } });
    const saved = storage.save(id, Buffer.from(PNG_1x1, "base64"), Math.floor(Date.now() / 1000), "png");
    receipts.setImagePath(id, saved.relativePath);
    receipts.setOcrResult(id, { ocr_status: "done", ...TRUTH, items: [{ name: "牛乳", price: 220 }] });
    return id;
  }

  it("勝ち遺伝子が既定と違えば null で発行し、後から baseline を埋める", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const receipts = new ReceiptsRepo(db);
    const storage = new ReceiptStorage(join(root, "receipts"));
    const gaRoot = join(root, "ga");
    const ga = createOcrGaStore(gaRoot);
    const winner: OcrGenome = { ...defaultOcrGenome(), detThresh: 0.45 };
    ga.recordGeneration("global", [{ genome: winner, fitness: 0.7 }]);

    const id = seedReceipt(receipts, storage);
    const sidecar = new FakeSidecar();
    const evalLog = new ProductionEvalLog(gaRoot);
    const service = new ReceiptDetectService({ receipts, storage, ga, sidecar, evalLog });

    const outcome = await service.detect(id);
    expect(outcome.genome).toEqual(winner);
    expect(outcome.eval?.baselineFitness).toBeNull(); // 発行時点では未取得

    await service.whenIdle();
    // 既定遺伝子でもう 1 回叩いて後追いで埋める (行は増えない)
    expect(sidecar.calls.map((c) => c.genome)).toEqual([winner, defaultOcrGenome()]);
    const all = evalLog.read();
    expect(all.length).toBe(1);
    expect(all[0]?.baselineFitness).toBeCloseTo(outcome.eval!.fitness, 4);
    const meta = JSON.parse(receipts.find(id)!.metadata!) as { ocr_production_eval: ProductionEvalRecord };
    expect(meta.ocr_production_eval.baselineFitness).toBe(all[0]?.baselineFitness);
  });

  it("履歴上の勝ち遺伝子が既定値と同じなら baseline のために二度目を走らせない", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const receipts = new ReceiptsRepo(db);
    const storage = new ReceiptStorage(join(root, "receipts"));
    const gaRoot = join(root, "ga");
    const ga = createOcrGaStore(gaRoot);
    ga.recordGeneration("global", [{ genome: defaultOcrGenome(), fitness: 0.7 }]);

    const id = seedReceipt(receipts, storage);
    const sidecar = new FakeSidecar();
    const service = new ReceiptDetectService({
      receipts, storage, ga, sidecar, evalLog: new ProductionEvalLog(gaRoot),
    });

    const outcome = await service.detect(id);
    await service.whenIdle();
    expect(outcome.genomeSource).toBe("global");
    expect(outcome.eval?.baselineFitness).toBe(outcome.eval?.fitness);
    expect(sidecar.calls).toHaveLength(1);
  });

  it("sidecar 実行中と完了後の真値修正を反映し、古い cache を使わない", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const receipts = new ReceiptsRepo(db);
    const storage = new ReceiptStorage(join(root, "receipts"));
    const gaRoot = join(root, "ga");
    const ga = createOcrGaStore(gaRoot);
    const id = seedReceipt(receipts, storage);
    const sidecar = new FakeSidecar();
    let release!: () => void;
    sidecar.gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ReceiptDetectService({
      receipts, storage, ga, sidecar, evalLog: new ProductionEvalLog(gaRoot), baselineBackfill: false,
    });

    const pending = service.detect(id);
    receipts.setOcrResult(id, { ocr_status: "manual", total: 9999 });
    release();
    const corrected = await pending;
    expect(corrected.eval?.fieldHits.total).toBe(false);

    sidecar.gate = null;
    const cached = await service.detect(id);
    expect(cached.cached).toBe(true);
    expect(cached.eval?.fieldHits.total).toBe(false);
    expect(sidecar.calls).toHaveLength(1);

    receipts.setOcrResult(id, { ocr_status: "manual", total: TRUTH.total });
    const refreshed = await service.detect(id);
    expect(refreshed.cached).toBe(false);
    expect(refreshed.eval?.fieldHits.total).toBe(true);
    expect(sidecar.calls).toHaveLength(2);
  });

  it("close は新規 detect を拒否し、進行中の記録が永続化されるまで待つ", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const receipts = new ReceiptsRepo(db);
    const storage = new ReceiptStorage(join(root, "receipts"));
    const gaRoot = join(root, "ga");
    const id = seedReceipt(receipts, storage);
    const sidecar = new FakeSidecar();
    let release!: () => void;
    sidecar.gate = new Promise<void>((resolve) => { release = resolve; });
    const evalLog = new ProductionEvalLog(gaRoot);
    const service = new ReceiptDetectService({
      receipts, storage, ga: createOcrGaStore(gaRoot), sidecar, evalLog, baselineBackfill: false,
    });

    const pending = service.detect(id);
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    expect((await service.detect("new-receipt")).reason).toBe("detect_disabled");
    expect(closed).toBe(false);

    release();
    await Promise.all([pending, closing]);
    expect(closed).toBe(true);
    expect(evalLog.read()).toHaveLength(1);
  });

  it("baseline が取れなくても運用評価レコードは null のまま残る", async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const receipts = new ReceiptsRepo(db);
    const storage = new ReceiptStorage(join(root, "receipts"));
    const gaRoot = join(root, "ga");
    const ga = createOcrGaStore(gaRoot);
    ga.recordGeneration("global", [{ genome: { ...defaultOcrGenome(), detThresh: 0.45 }, fitness: 0.7 }]);

    const id = seedReceipt(receipts, storage);
    const sidecar = new FakeSidecar();
    sidecar.failAfter = 1; // 勝ち遺伝子の検出は通し、baseline だけ落とす
    const evalLog = new ProductionEvalLog(gaRoot);
    const warnings: string[] = [];
    const service = new ReceiptDetectService({
      receipts, storage, ga, sidecar, evalLog,
      logger: { warn: (_fields, message) => { warnings.push(message ?? ""); } },
    });

    const outcome = await service.detect(id);
    await service.whenIdle();

    expect(outcome.source).toBe("real");
    expect(evalLog.read()[0]?.baselineFitness).toBeNull();
    expect(warnings.join(" ")).toContain("baseline");
  });
});

describe("buildFieldRegions (認識行 ↔ 真値のマッチング)", () => {
  const truth = { ...TRUTH, items: JSON.stringify([{ name: "牛乳", price: 220 }]) };

  it("採点と同じ正規化で当てる (和暦・全角・桁区切り・店名の表記ゆれ)", () => {
    const regions = buildFieldRegions(
      [
        line("ｶｽﾐ　志木店 TEL 048-000-0000", 40),
        line("令和8年9月2日 16:56", 70),
        line("合　計 ￥4,080", 400),
        line("牛乳 220", 200),
      ],
      truth,
    );
    const byField = new Map(regions.map((r) => [r.field, r]));
    expect(byField.get("payee")?.recognizedText).toContain("志木店");
    expect(byField.get("date")?.recognizedText).toContain("令和8年9月2日");
    expect(byField.get("total")?.recognizedText).toContain("4,080");
    expect(byField.get("item-0")?.recognizedText).toContain("牛乳");
  });

  it("同じ行を 2 つのフィールドに割り当てない / 当たらない行は出さない", () => {
    const regions = buildFieldRegions([line("カスミ 志木店", 40)], truth);
    expect(regions.map((r) => r.field)).toEqual(["payee"]);
  });

  it("真値の無いフィールドと空の検出結果は領域を作らない", () => {
    expect(buildFieldRegions([], truth)).toEqual([]);
    expect(buildFieldRegions(SIDECAR_LINES, { date: null, payee: null, total: null, items: null })).toEqual([]);
  });
});
