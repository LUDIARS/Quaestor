import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReceiptStorage } from "../src/services/receipt-storage.js";
import { OcrWorker } from "../src/services/ocr-worker.js";
import type { OcrClient, ReceiptOcrResult } from "../src/services/ocr-client.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

class FakeOcrClient implements OcrClient {
  public calls = 0;
  constructor(private readonly result: ReceiptOcrResult) {}
  async extract(): Promise<ReceiptOcrResult> {
    this.calls++;
    return this.result;
  }
}

const HIGH: ReceiptOcrResult = {
  date: "2025-04-15",
  payee: "テスト店",
  total: 1000,
  currency: "JPY",
  items: [],
  raw: "{}",
  confidence: "high",
};

describe("OcrWorker", () => {
  let db: Database.Database;
  let receipts: ReceiptsRepo;
  let storage: ReceiptStorage;
  let storageRoot: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    receipts = new ReceiptsRepo(db);
    storageRoot = mkdtempSync(join(tmpdir(), "qworker-"));
    storage = new ReceiptStorage(storageRoot);
  }, 30_000);
  afterEach(() => {
    db.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  function seedPending(): string {
    const id = receipts.insert({});
    const saved = storage.save(id, PNG_1x1, new Date(), "png");
    receipts.setImagePath(id, saved.relativePath);
    return id;
  }

  it("tickOnce: 1 件だけ処理して done に遷移する", async () => {
    seedPending();
    seedPending();   // 2 件あっても 1 tick で 1 件
    const client = new FakeOcrClient(HIGH);
    const w = new OcrWorker({ receipts, storage, client });
    const r = await w.tickOnce();
    expect(r.processed).toBe(true);
    expect(r.status).toBe("done");
    expect(client.calls).toBe(1);
    // pending 件数: 1 件は処理済 (done)、 残り 1 件 pending
    const pending = receipts.list({ status: "pending" });
    const done = receipts.list({ status: "done" });
    expect(pending).toHaveLength(1);
    expect(done).toHaveLength(1);
  });

  it("tickOnce: pending 0 件で何もしない", async () => {
    const client = new FakeOcrClient(HIGH);
    const w = new OcrWorker({ receipts, storage, client });
    const r = await w.tickOnce();
    expect(r.processed).toBe(false);
    expect(client.calls).toBe(0);
  });

  it("tickOnce: image_path 無しの pending は skip", async () => {
    receipts.insert({});  // image_path 無し
    const client = new FakeOcrClient(HIGH);
    const w = new OcrWorker({ receipts, storage, client });
    const r = await w.tickOnce();
    expect(r.processed).toBe(false);
    expect(client.calls).toBe(0);
  });

  it("start/stop: timer ループが回り、 stop で止まる", async () => {
    seedPending();
    seedPending();
    const client = new FakeOcrClient(HIGH);
    const w = new OcrWorker({ receipts, storage, client, intervalMs: 20 });
    w.start();
    // 100ms 待つ → 数回 tick できるはず
    await new Promise((r) => setTimeout(r, 200));
    w.stop();
    expect(client.calls).toBeGreaterThanOrEqual(2);
    // 全て処理済
    expect(receipts.list({ status: "pending" })).toHaveLength(0);
    expect(receipts.list({ status: "done" })).toHaveLength(2);
  });

  it("start: stop 後に再 start しても動かない", async () => {
    const client = new FakeOcrClient(HIGH);
    const w = new OcrWorker({ receipts, storage, client, intervalMs: 10 });
    w.start();
    w.stop();
    seedPending();
    w.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.calls).toBe(0);
  });
});
