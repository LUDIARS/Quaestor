import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { ReconciliationsRepo } from "../src/db/reconciliations-repo.js";
import { analyzeBehavior, dataCoverage, resolveRange, addMonths } from "../src/services/behavior-analysis.js";

describe("analyzeBehavior", () => {
  let db: Database.Database;
  let receipts: ReceiptsRepo;
  let txs: TransactionsRepo;
  let seedCounter = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    receipts = new ReceiptsRepo(db);
    txs = new TransactionsRepo(db);
    seedCounter = 0;
  });

  function seedTx(date: string, payee: string, amount: number) {
    seedCounter++;
    return txs.insertOne({
      date, amount_in: null, amount_out: amount,
      currency: "JPY", fx_amount: null, fx_currency: null,
      description: payee, payee,
      source: "credit-card",
      source_id: `${date}|${amount}|${payee}|${seedCounter}`,
      account: "UFJクレカ",
      metadata: {},
    });
  }

  function seedCommittedReceipt(date: string, payee: string, total: number) {
    const id = receipts.insert({});
    receipts.setOcrResult(id, { ocr_status: "done", date, payee, total });
    receipts.commit(id);
    return id;
  }

  it("aggregates by normalized payee (width/case/space), sorted by spend", () => {
    // 全角英数 + 全角空白 + 大小文字違いは同一キーに集約される
    seedTx("2025-04-01", "Starbucks Shibuya", 1000);
    seedTx("2025-04-05", "ＳＴＡＲＢＵＣＫＳ　ｓｈｉｂｕｙａ", 2000);
    seedTx("2025-04-10", "ローソン", 500);

    const r = analyzeBehavior(db);
    expect(r).toHaveLength(2);
    expect(r[0]!.payee_norm).toBe("STARBUCKS SHIBUYA");
    expect(r[0]!.visits).toBe(2);
    expect(r[0]!.total_spend).toBe(3000);
    expect(r[1]!.total_spend).toBe(500);
  });

  it("does NOT merge different branch suffixes (handled later at ticker level)", () => {
    seedTx("2025-04-01", "イオン 中目黒店", 1000);
    seedTx("2025-04-05", "イオンスタイル", 2000);
    // 店名が異なるので行動解析では別エントリ (suggestions で同一 ticker に束ねる)
    expect(analyzeBehavior(db)).toHaveLength(2);
  });

  it("ignores transfers and income (amount_in only)", () => {
    txs.insertOne({
      date: "2025-04-01", amount_in: 50000, amount_out: null,
      currency: "JPY", fx_amount: null, fx_currency: null,
      description: "給与", payee: "勤務先",
      source: "bank", source_id: "in1", account: "UFJ銀行", metadata: {},
    });
    txs.insertOne({
      date: "2025-04-02", amount_in: null, amount_out: 10000,
      currency: "JPY", fx_amount: null, fx_currency: null,
      description: "振替", payee: "自分", is_transfer: true,
      source: "bank", source_id: "tr1", account: "UFJ銀行", metadata: {},
    });
    seedTx("2025-04-03", "イオン", 3000);

    const r = analyzeBehavior(db);
    expect(r).toHaveLength(1);
    expect(r[0]!.payee_sample).toBe("イオン");
  });

  it("adds committed receipts but not reconciled ones (no double count)", () => {
    // tx と reconcile 済 receipt → tx 側のみ計上
    const txId = seedTx("2025-04-15", "ヤマダ電機", 8000)!;
    const recId = seedCommittedReceipt("2025-04-15", "ヤマダ電機", 8000);
    new ReconciliationsRepo(db).insert({
      receipt_id: recId, transaction_id: txId, matched_by: "manual", confidence: 0.9,
    });
    // 別の現金レシート (未 reconcile) → 計上される
    seedCommittedReceipt("2025-04-20", "個人商店", 1500);

    const r = analyzeBehavior(db);
    const yamada = r.find((e) => e.payee_sample.includes("ヤマダ"));
    expect(yamada?.visits).toBe(1);          // 二重計上されていない
    expect(yamada?.total_spend).toBe(8000);
    expect(r.find((e) => e.payee_sample.includes("個人商店"))?.sources).toContain("receipt");
  });

  it("respects date range and minVisits filters", () => {
    seedTx("2025-03-01", "店A", 100);
    seedTx("2025-04-01", "店B", 200);
    seedTx("2025-04-02", "店B", 200);

    expect(analyzeBehavior(db, { from: "2025-04-01" })).toHaveLength(1);
    expect(analyzeBehavior(db, { minVisits: 2 }).map((e) => e.payee_sample)).toEqual(["店B"]);
  });

  it("excludes uncommitted receipts", () => {
    const id = receipts.insert({});
    receipts.setOcrResult(id, { ocr_status: "done", date: "2025-04-01", payee: "未投入店", total: 999 });
    // commit していない
    expect(analyzeBehavior(db)).toHaveLength(0);
  });
});

describe("addMonths", () => {
  it("加減算と年跨ぎ", () => {
    expect(addMonths("2025-04", -3)).toBe("2025-01");
    expect(addMonths("2025-02", -3)).toBe("2024-11");
    expect(addMonths("2025-11", 3)).toBe("2026-02");
  });
});

describe("source filter / coverage / 月次窓", () => {
  let db: Database.Database;
  let receipts: ReceiptsRepo;
  let txs: TransactionsRepo;
  let n = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    receipts = new ReceiptsRepo(db);
    txs = new TransactionsRepo(db);
    n = 0;
  });

  function seedTx(date: string, payee: string, amount: number, source: "credit-card" | "bank") {
    n++;
    txs.insertOne({
      date, amount_in: null, amount_out: amount,
      currency: "JPY", fx_amount: null, fx_currency: null,
      description: payee, payee, source,
      source_id: `${source}|${date}|${amount}|${n}`, account: source, metadata: {},
    });
  }

  function seedReceipt(date: string, payee: string, total: number) {
    const id = receipts.insert({});
    receipts.setOcrResult(id, { ocr_status: "done", date, payee, total });
    receipts.commit(id);
  }

  it("source=credit-card は credit-card tx のみ (receipts 除外)", () => {
    seedTx("2025-04-01", "クレカ店", 1000, "credit-card");
    seedTx("2025-04-02", "銀行引落", 2000, "bank");
    seedReceipt("2025-04-03", "現金店", 500);

    const r = analyzeBehavior(db, { source: "credit-card" });
    expect(r).toHaveLength(1);
    expect(r[0]!.payee_sample).toBe("クレカ店");
  });

  it("source 未指定は tx 全 source + receipts", () => {
    seedTx("2025-04-01", "クレカ店", 1000, "credit-card");
    seedTx("2025-04-02", "銀行引落", 2000, "bank");
    seedReceipt("2025-04-03", "現金店", 500);
    expect(analyzeBehavior(db)).toHaveLength(3);
  });

  it("dataCoverage は source で絞れる", () => {
    seedTx("2025-01-15", "A", 100, "credit-card");
    seedTx("2025-03-15", "B", 100, "credit-card");
    seedTx("2025-04-15", "C", 100, "bank");
    const all = dataCoverage(db);
    expect(all.months).toEqual(["2025-01", "2025-03", "2025-04"]);
    expect(all.latest).toBe("2025-04");
    const cc = dataCoverage(db, "credit-card");
    expect(cc.months).toEqual(["2025-01", "2025-03"]);
    expect(cc.latest).toBe("2025-03");
  });

  it("resolveRange は from/to 未指定なら最終月から直近N月", () => {
    seedTx("2025-01-15", "A", 100, "credit-card");
    seedTx("2025-04-15", "B", 100, "credit-card");
    const r = resolveRange(db, { months: 2 });
    expect(r.from).toBe("2025-03-01");
    expect(r.to).toBe("2025-04-31");
    // from/to 明示はそのまま
    expect(resolveRange(db, { from: "2024-01-01" })).toEqual({ from: "2024-01-01", to: undefined });
    // months=0 は制約なし
    expect(resolveRange(db, { months: 0 })).toEqual({});
  });

  it("既定窓 (months) で古い月を除外して集計する", () => {
    seedTx("2024-01-15", "古い店", 9999, "credit-card");
    seedTx("2025-03-15", "今の店A", 1000, "credit-card");
    seedTx("2025-04-15", "今の店B", 2000, "credit-card");
    // 最終 2025-04 から直近 2 月 → 2024-01 は窓外
    const r = analyzeBehavior(db, { months: 2 });
    expect(r.map((e) => e.payee_sample).sort()).toEqual(["今の店A", "今の店B"]);
  });
});
