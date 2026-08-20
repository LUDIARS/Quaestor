import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReconciliationsRepo } from "../src/db/reconciliations-repo.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

describe("レシート自動投入 + 到着順に依存しない突合", () => {
  let db: Database.Database;
  let app: ReturnType<typeof buildApp>;
  let receiptsRoot: string;
  let txs: TransactionsRepo;
  let receipts: ReceiptsRepo;
  let recons: ReconciliationsRepo;
  let seq = 0;

  beforeEach(() => {
    receiptsRoot = mkdtempSync(join(tmpdir(), "quaestor-intake-"));
    db = new Database(":memory:");
    app = buildApp({ db, receiptsRoot });
    txs = new TransactionsRepo(db);
    receipts = new ReceiptsRepo(db);
    recons = new ReconciliationsRepo(db);
  });
  afterEach(() => { rmSync(receiptsRoot, { recursive: true, force: true }); });

  function seedTx(date: string, payee: string, amount: number): void {
    seq++;
    txs.insertOne({
      date, amount_in: null, amount_out: amount,
      currency: "JPY", fx_amount: null, fx_currency: null,
      description: payee, payee,
      source: "credit-card",
      source_id: `${date}|${amount}|${payee}|${seq}`,
      account: "UFJクレカ",
      metadata: {},
    });
  }

  async function createReceipt(): Promise<string> {
    // image hash dedup (30s window) を避けるため毎回バイト列を変える
    seq++;
    const buf = Buffer.from(PNG_1x1, "base64");
    buf[buf.length - 1] = seq % 256;
    const res = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: buf.toString("base64"), ext: "png" }),
    });
    const j = await res.json() as { receipt: { id: string } };
    return j.receipt.id;
  }

  async function patchOcr(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await app.request(`/v1/receipts/${id}/ocr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json() as Record<string, unknown>;
  }

  it("OCR が完備で終わったら人手を介さず投入される", async () => {
    const id = await createReceipt();
    const j = await patchOcr(id, {
      ocr_status: "done", date: "2026-04-15", payee: "サイゼリヤ 中目黒店", total: 1820,
    });
    expect(j.auto_commit).toEqual({ committed: true, already: false });
    expect(receipts.find(id)!.committed_at).not.toBeNull();
  });

  it("欠損があれば投入せず手動確認へ残す", async () => {
    const id = await createReceipt();
    const j = await patchOcr(id, { ocr_status: "done", date: "2026-04-15", payee: "X" });
    expect(j.auto_commit).toEqual({ committed: false, reason: "incomplete" });
    expect(receipts.find(id)!.committed_at).toBeNull();
  });

  it("同じ (日付-場所-金額) の 2 枚目は自動投入されない", async () => {
    const first = await createReceipt();
    await patchOcr(first, { ocr_status: "done", date: "2026-04-15", payee: "STORE A", total: 500 });
    const second = await createReceipt();
    const j = await patchOcr(second, { ocr_status: "done", date: "2026-04-15", payee: "STORE A", total: 500 });
    expect(j.auto_commit).toEqual({ committed: false, reason: "duplicate" });
    expect(receipts.find(second)!.committed_at).toBeNull();
  });

  it("取引が先にあれば、 レシート投入の時点で突合が成立する", async () => {
    seedTx("2026-04-15", "サイゼリヤ／ＮＦＣ", 1820);
    const id = await createReceipt();
    await patchOcr(id, {
      ocr_status: "done", date: "2026-04-15", payee: "サイゼリヤ 中目黒店", total: 1820,
    });
    expect(recons.byReceipt(id)).toHaveLength(1);
    expect(recons.byReceipt(id)[0]!.matched_by).toBe("auto");
  });

  it("レシートが先でも、 取引を取り込んだ時点で突合が成立する", async () => {
    const id = await createReceipt();
    await patchOcr(id, {
      ocr_status: "done", date: "2026-04-15", payee: "サイゼリヤ 中目黒店", total: 1820,
    });
    expect(recons.byReceipt(id)).toHaveLength(0);   // まだ取引が無い

    seedTx("2026-04-15", "サイゼリヤ／ＮＦＣ", 1820);
    const res = await app.request("/v1/reconciliations/auto-match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await res.json() as { matched: unknown[] };
    expect(j.matched).toHaveLength(1);
    expect(recons.byReceipt(id)).toHaveLength(1);
  });

  it("未投入レシートは突合の母集団に入らない", async () => {
    seedTx("2026-04-15", "STORE B", 700);
    const id = await createReceipt();
    // 欠損ありなので自動投入されない
    await patchOcr(id, { ocr_status: "done", date: "2026-04-15", payee: "STORE B" });
    const res = await app.request("/v1/reconciliations/auto-match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await res.json() as { matched: unknown[] };
    expect(j.matched).toHaveLength(0);
  });

  it("autoIntake=false なら従来どおり手動投入のみ", async () => {
    const manualDb = new Database(":memory:");
    const manualApp = buildApp({ db: manualDb, receiptsRoot, autoIntake: false });
    const create = await manualApp.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    });
    const id = (await create.json() as { receipt: { id: string } }).receipt.id;
    await manualApp.request(`/v1/receipts/${id}/ocr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ocr_status: "done", date: "2026-04-15", payee: "STORE C", total: 300 }),
    });
    expect(new ReceiptsRepo(manualDb).find(id)!.committed_at).toBeNull();
  });
});
