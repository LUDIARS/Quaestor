import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { ImportsRepo } from "../src/db/imports-repo.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { JournalEntriesRepo } from "../src/db/journal-entries-repo.js";
import { FixedAssetsRepo } from "../src/db/fixed-assets-repo.js";
import { collectActivity } from "../src/services/activity-log.js";
import { buildApp } from "../src/app.js";

function setup() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return { db, txs: new TransactionsRepo(db), imports: new ImportsRepo(db), receipts: new ReceiptsRepo(db), entries: new JournalEntriesRepo(db), assets: new FixedAssetsRepo(db) };
}

describe("activity log", () => {
  it("各種イベントを時刻降順で混ぜ、 仕訳取込は 1 件に束ねる", () => {
    const s = setup();
    const importId = s.imports.insert({ source: "credit-card", brand: "ufj", account: "UFJクレカ", filename: "202508.csv", metadata: {} });
    s.txs.insertOne({ date: "2026-08-01", amount_in: null, amount_out: 100, currency: "JPY", fx_amount: null, fx_currency: null, description: "x", payee: "x", source: "credit-card", source_id: "a", account: "UFJクレカ", import_id: importId, metadata: {} });
    s.txs.insertOne({ date: "2026-08-02", amount_in: null, amount_out: 200, currency: "JPY", fx_amount: null, fx_currency: null, description: "y", payee: "y", source: "credit-card", source_id: "b", account: "UFJクレカ", import_id: importId, metadata: {} });
    const rid = s.receipts.insert({ captured_at: 1, metadata: {} });
    s.receipts.setOcrResult(rid, { ocr_status: "done", date: "2026-08-03", payee: "サイゼリヤ", total: 1_820, items: [], ocr_raw: "{}" });
    s.receipts.commit(rid);
    for (let i = 0; i < 3; i++) {
      s.entries.insert({ fiscal_year: 2025, entry_date: "2025-01-01", debit_code: 26, debit_amount: 1, credit_code: 102, credit_amount: 1, description: "imp", payment: 1, rate: 1, origin: "imported", locked: true });
    }
    s.entries.insert({ fiscal_year: 2026, entry_date: "2026-01-01", debit_code: 102, debit_amount: 5_000, credit_code: 1, credit_amount: 5_000, description: "売上", payment: 5_000, rate: 1, origin: "manual", locked: true });
    s.assets.insert({ name: "PC", acquired_on: "2026-01-01", cost: 100_000, method: "straight_line", useful_life: 4 });

    const events = collectActivity(s.db, 50);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["import", "receipt_captured", "receipt_committed", "journal_imported", "journal_manual", "fixed_asset"]));
    expect(events.filter((e) => e.kind === "journal_imported")).toHaveLength(1);
    expect(events.find((e) => e.kind === "journal_imported")!.detail).toContain("3 行");
    expect(events.find((e) => e.kind === "import")!.detail).toContain("2 件");
    expect(events.find((e) => e.kind === "receipt_committed")!.title).toContain("サイゼリヤ");
    for (let i = 1; i < events.length; i++) expect(events[i - 1]!.at).toBeGreaterThanOrEqual(events[i]!.at);
    expect(collectActivity(s.db, 2)).toHaveLength(2);
    expect(events.every((e) => typeof e.page === "string" && e.page.length > 0)).toBe(true);
  });

  it("GET /v1/activity は limit を検証する", async () => {
    const app = buildApp({ db: new Database(":memory:") });
    const ok = await app.request("/v1/activity?limit=5");
    expect(ok.status).toBe(200);
    expect((await ok.json() as { items: unknown[] }).items).toHaveLength(5);
    expect((await app.request("/v1/activity?limit=0")).status).toBe(400);
  });
});
