import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { buildJournal } from "../src/services/journal.js";
import { isoToExcelSerial, buildJournalWorkbook } from "../src/services/excel-export.js";
import ExcelJS from "exceljs";
import { buildApp } from "../src/app.js";

function setup() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const txs = new TransactionsRepo(db);
  const accounts = new AccountCodesRepo(db);
  const rules = new ApportionmentRulesRepo(db);
  accounts.seedIfEmpty();
  rules.seedIfEmpty();
  const accountNames: Record<number, string> = {};
  for (const a of accounts.list()) accountNames[a.code] = a.name;
  return { db, txs, accounts, rules, accountNames };
}

function seedTx(txs: TransactionsRepo, date: string, payee: string, amount: number, account = "UFJクレカ") {
  return txs.insertOne({
    date,
    amount_in: null,
    amount_out: amount,
    currency: "JPY",
    fx_amount: null,
    fx_currency: null,
    description: payee,
    payee,
    source: "credit-card",
    source_id: `${date}|${amount}|${payee}`,
    account,
    metadata: {},
  });
}

describe("isoToExcelSerial", () => {
  it("known dates round-trip", () => {
    expect(isoToExcelSerial("1900-01-01")).toBe(2);   // Excel の 1900-01-01 = serial 1 だが 2 が正しい (1900 leap year bug 補正後)
    expect(isoToExcelSerial("2025-01-15")).toBe(45672);
    expect(isoToExcelSerial("2025-04-15")).toBe(45762);
  });
});

describe("buildJournal", () => {
  it("100% 経費 (NOTION) は 1 行 (借方 26 / 貸方 102)", () => {
    const { db, txs, rules, accountNames } = setup();
    seedTx(txs, "2025-04-15", "NOTION LABS INC.", 1500);

    const entries = buildJournal(db, rules, { accountNames });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.debit_code).toBe(26);
    expect(e.debit_amount).toBe(1500);
    expect(e.credit_code).toBe(102);
    expect(e.credit_amount).toBe(1500);
    expect(e.rate).toBe(1);
    expect(e.description).toContain("NOTION");
  });

  it("70% 経費 (au) は 2 行 (経費 70%、 家計 30%)", () => {
    const { db, txs, rules, accountNames } = setup();
    seedTx(txs, "2025-04-20", "ａｕ電話利用料", 5000);

    const entries = buildJournal(db, rules, { accountNames });
    expect(entries).toHaveLength(2);
    const [exp, household] = [entries[0]!, entries[1]!];
    expect(exp.debit_code).toBe(12);                  // 通信費
    expect(exp.debit_amount).toBe(3500);
    expect(household.debit_code).toBe(124);           // 事業主貸
    expect(household.debit_amount).toBe(1500);
    // 合計が元金額と一致
    expect(exp.debit_amount + household.debit_amount).toBe(5000);
    expect(household.description).toBe("クレカ引き落とし調整");
  });

  it("0% (家計) は 1 行 で 借方 124", () => {
    const { db, txs, rules, accountNames } = setup();
    seedTx(txs, "2025-04-25", "未登録ショップ XYZ", 1234);

    const entries = buildJournal(db, rules, { accountNames });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.debit_code).toBe(124);
    expect(entries[0]!.debit_amount).toBe(1234);
    expect(entries[0]!.rate).toBe(0);
  });

  it("date filter", () => {
    const { db, txs, rules, accountNames } = setup();
    seedTx(txs, "2025-03-01", "NOTION", 1000);
    seedTx(txs, "2025-04-01", "NOTION", 1000);
    seedTx(txs, "2025-05-01", "NOTION", 1000);

    const all = buildJournal(db, rules, { accountNames });
    expect(all).toHaveLength(3);

    const q2 = buildJournal(db, rules, { accountNames, date_from: "2025-04-01", date_to: "2025-06-30" });
    expect(q2).toHaveLength(2);
  });

  it("仕訳番号は連番", () => {
    const { db, txs, rules, accountNames } = setup();
    seedTx(txs, "2025-04-15", "NOTION", 1000);
    seedTx(txs, "2025-04-20", "NETFLIX", 1000); // 50% rate → 2 行
    const entries = buildJournal(db, rules, { accountNames, startNo: 100 });
    expect(entries.map((e) => e.no)).toEqual([100, 101, 102]);
  });
});

describe("buildJournalWorkbook → readback", () => {
  it("生成した xlsx を再パースして data row が見える", async () => {
    const { db, txs, rules, accountNames } = setup();
    seedTx(txs, "2025-04-15", "NOTION", 1500);
    const entries = buildJournal(db, rules, { accountNames });
    const buf = await buildJournalWorkbook(entries);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet("仕訳帳")!;
    expect(ws.getCell("B6").value).toBe("日付");
    // データ row 7 — ExcelJS は numFmt='yyyy/m/d' のセルを Date object として返す
    const b7 = ws.getCell("B7").value;
    expect(b7 instanceof Date || typeof b7 === "number").toBe(true);
    expect(ws.getCell("E7").value).toBe("ソフトウエア購入費");
    expect(ws.getCell("F7").value).toBe(1500);
    expect(ws.getCell("J7").value).toBe("NOTION");
  });
});

describe("API: /v1/exports", () => {
  it("GET /journal/preview returns entries", async () => {
    const app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qexp", ocr: "disabled" });
    // tx を直接 insert する API は無いので、 importer 経由で UFJ 1 件
    // (ここでは preview が空でも 200 を返すことを検証)
    const res = await app.request("/v1/exports/journal/preview");
    expect(res.status).toBe(200);
    const j = await res.json() as { count: number };
    expect(j.count).toBe(0);
  });

  it("GET /journal returns xlsx bytes", async () => {
    const app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qexp2", ocr: "disabled" });
    const res = await app.request("/v1/exports/journal");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);   // 空の xlsx でも数 KB ある
  });
});
