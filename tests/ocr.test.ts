import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { OcrClient, ReceiptOcrResult } from "../src/services/ocr-client.js";
import { runOcrFor } from "../src/services/ocr-runner.js";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReceiptStorage } from "../src/services/receipt-storage.js";
import { ReceiptIntake } from "../src/services/receipt-intake.js";
import { ReconciliationsRepo } from "../src/db/reconciliations-repo.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

class FakeOcrClient implements OcrClient {
  calls = 0;

  constructor(private readonly result: ReceiptOcrResult) {}
  async extract(): Promise<ReceiptOcrResult> {
    this.calls++;
    return this.result;
  }
}

class FailingOcrClient implements OcrClient {
  async extract(): Promise<ReceiptOcrResult> {
    throw new Error("network error");
  }
}

const HIGH_CONFIDENCE_RESULT: ReceiptOcrResult = {
  date: "2025-04-15",
  payee: "サイゼリヤ 中目黒店",
  total: 1820,
  currency: "JPY",
  items: [
    { name: "ミラノ風ドリア", price: 460, qty: 1 },
    { name: "ハンバーグ", price: 600, qty: 1 },
  ],
  raw: '{"payee":"サイゼリヤ 中目黒店","total":1820}',
  confidence: "high",
};

const LOW_CONFIDENCE_RESULT: ReceiptOcrResult = {
  date: null,
  payee: null,
  total: null,
  currency: "JPY",
  items: [],
  raw: '{}',
  confidence: "low",
};

const CLASSIFIED_INVOICE_RESULT: ReceiptOcrResult = {
  ...HIGH_CONFIDENCE_RESULT,
  labels: {
    kind: "invoice",
    kind_fields: { issuer: "テスト請求元", due_date: "2025-04-30", invoice_no: "INV-1" },
    sample: { role: "good_sample", tags: [], reason: "全体が判読できる" },
    content_tags: ["business"],
  },
};

describe("runOcrFor (unit)", () => {
  let db: Database.Database;
  let receipts: ReceiptsRepo;
  let storage: ReceiptStorage;
  let receiptId: string;
  let storageRoot: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    receipts = new ReceiptsRepo(db);
    storageRoot = mkdtempSync(join(tmpdir(), "qocr-"));
    storage = new ReceiptStorage(storageRoot);
    // 1×1 PNG を実体保存して image_path を入れた pending receipt を 1 つ作る
    receiptId = receipts.insert({});
    const buf = Buffer.from(PNG_1x1, "base64");
    const saved = storage.save(receiptId, buf, new Date(), "png");
    receipts.setImagePath(receiptId, saved.relativePath);
  });
  afterEach(() => { rmSync(storageRoot, { recursive: true, force: true }); });

  it("high confidence → status='done' + fields populated", async () => {
    const r = await runOcrFor(receiptId, {
      receipts, storage, client: new FakeOcrClient(HIGH_CONFIDENCE_RESULT),
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("done");
    const row = receipts.find(receiptId)!;
    expect(row.ocr_status).toBe("done");
    expect(row.payee).toBe("サイゼリヤ 中目黒店");
    expect(row.total).toBe(1820);
    expect(JSON.parse(row.items!)).toHaveLength(2);
  });

  it("low confidence → status='manual' (人間レビュー)", async () => {
    const r = await runOcrFor(receiptId, {
      receipts, storage, client: new FakeOcrClient(LOW_CONFIDENCE_RESULT),
    });
    expect(r.status).toBe("manual");
    expect(receipts.find(receiptId)!.ocr_status).toBe("manual");
  });

  it("SDK の分類を intake より先に保存し、 invoice を receipt として自動投入しない", async () => {
    const intake = new ReceiptIntake({
      db,
      receipts,
      reconciliations: new ReconciliationsRepo(db),
    });
    const r = await runOcrFor(receiptId, {
      receipts,
      storage,
      client: new FakeOcrClient(CLASSIFIED_INVOICE_RESULT),
      intake,
    });

    expect(r).toMatchObject({ ok: true, status: "done" });
    const row = receipts.find(receiptId)!;
    expect(row.doc_kind).toBe("invoice");
    expect(row.sample_role).toBe("good_sample");
    expect(row.sample_source).toBe("llm");
    expect(row.committed_at).toBeNull();
  });

  it("client throw → status='failed' + ocr_raw に error 記録", async () => {
    const r = await runOcrFor(receiptId, { receipts, storage, client: new FailingOcrClient() });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    const row = receipts.find(receiptId)!;
    expect(row.ocr_status).toBe("failed");
    expect(row.ocr_raw).toContain("network error");
  });

  it("missing image_path → failed", async () => {
    const id2 = receipts.insert({});  // image_path なし
    const r = await runOcrFor(id2, {
      receipts, storage, client: new FakeOcrClient(HIGH_CONFIDENCE_RESULT),
    });
    expect(r.status).toBe("failed");
  });

  it("does not rerun OCR after commit", async () => {
    receipts.setOcrResult(receiptId, {
      ocr_status: "done", date: "2025-04-15", payee: "確定済", total: 100,
    });
    receipts.commit(receiptId);
    const client = new FakeOcrClient(HIGH_CONFIDENCE_RESULT);

    const result = await runOcrFor(receiptId, { receipts, storage, client });

    expect(result).toMatchObject({ ok: false, message: "receipt already committed" });
    expect(client.calls).toBe(0);
    expect(receipts.find(receiptId)).toMatchObject({ payee: "確定済", total: 100, ocr_status: "done" });
  });
});

describe("API: POST /v1/receipts/:id/ocr/run", () => {
  let app: ReturnType<typeof buildApp>;
  let receiptsRoot: string;

  beforeEach(() => {
    receiptsRoot = mkdtempSync(join(tmpdir(), "qocrapi-"));
  });
  afterEach(() => { rmSync(receiptsRoot, { recursive: true, force: true }); });

  it("returns 503 when ocr disabled", async () => {
    app = buildApp({ db: new Database(":memory:"), receiptsRoot, ocr: "disabled" });
    // まず receipt 作る
    const create = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    });
    const id = ((await create.json()) as { receipt: { id: string } }).receipt.id;

    const res = await app.request(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("runs OCR via injected fake client", async () => {
    app = buildApp({
      db: new Database(":memory:"),
      receiptsRoot,
      ocr: new FakeOcrClient(HIGH_CONFIDENCE_RESULT),
    });
    const create = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    });
    const id = ((await create.json()) as { receipt: { id: string } }).receipt.id;

    const res = await app.request(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; status: string; receipt: { payee: string; total: number } };
    expect(j.ok).toBe(true);
    expect(j.status).toBe("done");
    expect(j.receipt.payee).toBe("サイゼリヤ 中目黒店");
    expect(j.receipt.total).toBe(1820);
  });

  it("/ocr/run は 2 秒以内の連続呼び出しを throttle する", async () => {
    app = buildApp({
      db: new Database(":memory:"),
      receiptsRoot,
      ocr: new FakeOcrClient(HIGH_CONFIDENCE_RESULT),
    });
    const create = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    });
    const id = ((await create.json()) as { receipt: { id: string } }).receipt.id;

    const r1 = await app.request(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
    expect(r1.status).toBe(200);
    const j1 = await r1.json() as { throttled?: boolean };
    expect(j1.throttled).toBeFalsy();

    // 即座の 2 回目は throttle される
    const r2 = await app.request(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
    expect(r2.status).toBe(200);
    const j2 = await r2.json() as { throttled?: boolean };
    expect(j2.throttled).toBe(true);
  });

  it("health endpoint reports ocr_enabled flag", async () => {
    const enabledApp = buildApp({
      db: new Database(":memory:"),
      receiptsRoot,
      ocr: new FakeOcrClient(HIGH_CONFIDENCE_RESULT),
    });
    const j1 = await (await enabledApp.request("/health")).json() as { ocr_enabled: boolean };
    expect(j1.ocr_enabled).toBe(true);

    const disabledApp = buildApp({ db: new Database(":memory:"), receiptsRoot, ocr: "disabled" });
    const j2 = await (await disabledApp.request("/health")).json() as { ocr_enabled: boolean };
    expect(j2.ocr_enabled).toBe(false);
  });
});
