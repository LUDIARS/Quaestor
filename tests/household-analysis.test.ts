import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReconciliationsRepo } from "../src/db/reconciliations-repo.js";
import { HouseholdCategoriesRepo } from "../src/db/household-categories-repo.js";
import { HouseholdRulesRepo } from "../src/db/household-rules-repo.js";
import { HouseholdClassifier } from "../src/services/household/household-classifier.js";
import { analyzeHousehold, BUSINESS_PSEUDO_CATEGORY, gridKey } from "../src/services/household/household-analysis.js";
import { collectSpendEvents } from "../src/services/household/spend-events.js";

function setup() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const txs = new TransactionsRepo(db);
  const accounts = new AccountCodesRepo(db);
  const rules = new ApportionmentRulesRepo(db);
  accounts.seedIfEmpty();
  rules.seedIfEmpty();
  const receipts = new ReceiptsRepo(db);
  const recon = new ReconciliationsRepo(db);
  const categories = new HouseholdCategoriesRepo(db);
  const householdRules = new HouseholdRulesRepo(db);
  categories.seedMissing();
  householdRules.seedIfEmpty(categories);
  const classifier = new HouseholdClassifier(householdRules, categories);
  return { db, txs, rules, receipts, recon, categories, classifier, deps: { db, rules, classifier } };
}

function seedTx(txs: TransactionsRepo, date: string, payee: string, amount: number, account = "UFJクレカ") {
  return txs.insertOne({
    date, amount_in: null, amount_out: amount, currency: "JPY", fx_amount: null, fx_currency: null,
    description: payee, payee, source: "credit-card", source_id: `${date}|${amount}|${payee}|${account}`, account, metadata: {},
  });
}

function seedReceipt(s: ReturnType<typeof setup>, date: string, payee: string, total: number, geo?: { lat: number; lon: number }) {
  const id = s.receipts.insert({ captured_at: 1, geo: geo ?? null, metadata: {} });
  s.receipts.setOcrResult(id, { ocr_status: "done", date, payee, total, items: [{ name: "x", price: total }], ocr_raw: "{}" });
  s.receipts.commit(id);
  return id;
}

describe("spend events", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("突合済レシートは取引側に付き、 未突合の投入済レシートは現金イベントになる", () => {
    const txId = seedTx(s.txs, "2026-08-10", "サイゼリヤ／ＮＦＣ", 1_820)!;
    const linked = seedReceipt(s, "2026-08-10", "サイゼリヤ", 1_820, { lat: 35.6441, lon: 139.6983 });
    s.recon.insert({ receipt_id: linked, transaction_id: txId, matched_by: "manual", confidence: 1 });
    seedReceipt(s, "2026-08-11", "ラーメン屋", 900);
    const events = collectSpendEvents(s.db, { from: "2026-08-01", to: "2026-08-31" });
    expect(events).toHaveLength(2);
    const tx = events.find((e) => e.kind === "transaction")!;
    expect(tx.receipt_id).toBe(linked);
    expect(tx.geo).toEqual({ lat: 35.6441, lon: 139.6983 });
    expect(tx.amount).toBe(1_820);
    const cash = events.find((e) => e.kind === "receipt")!;
    expect(cash.amount).toBe(900);
    expect(cash.method).toContain("現金");
  });

  it("振替と入金と未投入レシートは含めない", () => {
    const id = seedTx(s.txs, "2026-08-10", "カード引落", 50_000);
    s.db.prepare("UPDATE transactions SET is_transfer = 1 WHERE id = ?").run(id);
    s.txs.insertOne({ date: "2026-08-12", amount_in: 100_000, amount_out: null, currency: "JPY", fx_amount: null, fx_currency: null, description: "振込", payee: "MELPOT", source: "bank", source_id: "in1", account: "SMBC", metadata: {} });
    const pending = s.receipts.insert({ captured_at: 1, metadata: {} });
    s.receipts.setOcrResult(pending, { ocr_status: "done", date: "2026-08-13", payee: "未投入", total: 500, items: [], ocr_raw: "{}" });
    expect(collectSpendEvents(s.db, { from: "2026-08-01", to: "2026-08-31" })).toHaveLength(0);
  });
});

describe("household analysis", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("費目別 / 場所別 / 決済手段別 / 日別 と前期間比を返し、 費目合計 = 支出合計", () => {
    // 今期 (2026-08)
    seedTx(s.txs, "2026-08-03", "セブン-イレブン 中目黒店", 600);
    seedTx(s.txs, "2026-08-03", "セブン-イレブン 中目黒店", 400);
    seedTx(s.txs, "2026-08-05", "NOTION LABS INC.", 14_679);           // 100% 事業
    seedTx(s.txs, "2026-08-07", "ＮＥＴＦＬＩＸ．ＣＯＭ", 2_000, "SMBC-3"); // 50% 事業 / 50% 家計
    // 前期 (2026-07)
    seedTx(s.txs, "2026-07-20", "セブン-イレブン 中目黒店", 300);
    const a = analyzeHousehold(s.deps, "month", "2026-08-15");
    expect(a.window.current).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(a.totals.current).toEqual({ spend: 17_679, household: 2_000, business: 15_679, count: 4 });
    expect(a.totals.previous.spend).toBe(300);
    expect(a.totals.delta).toBe(17_379);

    const catSum = a.by_category.reduce((t, c) => t + c.current, 0);
    expect(catSum).toBe(a.totals.current.spend);
    const konbini = a.by_category.find((c) => c.name === "食費(コンビニ)")!;
    expect(konbini).toMatchObject({ current: 1_000, previous: 300, delta: 700, count: 2 });
    const business = a.by_category.find((c) => c.category_id === BUSINESS_PSEUDO_CATEGORY.id)!;
    expect(business.current).toBe(15_679);
    const other = a.by_category.find((c) => c.name === "娯楽・サブスク")!;
    expect(other.current).toBe(1_000);

    expect(a.by_place[0]).toMatchObject({ payee_norm: "NOTION LABS INC.", amount: 14_679, business: 14_679 });
    const seven = a.by_place.find((p) => p.payee_norm.startsWith("セブン"))!;
    expect(seven).toMatchObject({ amount: 1_000, count: 2, previous: 300, category_name: "食費(コンビニ)" });

    expect(a.by_method.map((m) => m.method)).toEqual(["UFJクレカ", "SMBC-3"]);
    expect(a.daily).toHaveLength(31);
    expect(a.daily.find((d) => d.date === "2026-08-03")!.amount).toBe(1_000);
    expect(a.receipt_link).toEqual({ events: 4, with_receipt: 0, rate: 0 });
    expect(a.coverage.latest).toBe("2026-08");
  });

  it("地点別はレシート GPS を 100 m 格子で束ね、 突合レシートを二重計上しない", () => {
    const txId = seedTx(s.txs, "2026-08-10", "サイゼリヤ／ＮＦＣ", 1_820)!;
    const linked = seedReceipt(s, "2026-08-10", "サイゼリヤ", 1_820, { lat: 35.64412, lon: 139.69834 });
    s.recon.insert({ receipt_id: linked, transaction_id: txId, matched_by: "manual", confidence: 1 });
    seedReceipt(s, "2026-08-11", "喫茶店", 700, { lat: 35.64408, lon: 139.69829 });
    const a = analyzeHousehold(s.deps, "week", "2026-08-12");
    expect(a.totals.current.spend).toBe(2_520);
    expect(a.by_location).toHaveLength(1);
    expect(a.by_location[0]).toMatchObject({ ...gridKey(35.64412, 139.69834), amount: 2_520, count: 2 });
    expect(a.by_location[0]!.payees).toEqual(["サイゼリヤ／ＮＦＣ", "喫茶店"]);
    expect(a.receipt_link).toEqual({ events: 2, with_receipt: 2, rate: 1 });
  });

  it("データが無くても空の結果を返す", () => {
    const a = analyzeHousehold(s.deps, "year", "2026-08-12");
    expect(a.totals.current.spend).toBe(0);
    expect(a.by_category).toEqual([]);
    expect(a.coverage.latest).toBeNull();
  });
});
