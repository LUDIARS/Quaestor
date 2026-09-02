import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { JournalEntriesRepo } from "../src/db/journal-entries-repo.js";
import { HouseholdCategoriesRepo } from "../src/db/household-categories-repo.js";
import { HouseholdRulesRepo } from "../src/db/household-rules-repo.js";
import { HouseholdClassifier } from "../src/services/household/household-classifier.js";
import { JournalLedger } from "../src/services/bookkeeping/journal-ledger.js";
import { buildManualEntries } from "../src/services/bookkeeping/manual-entries.js";

function setup() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const txs = new TransactionsRepo(db);
  const accounts = new AccountCodesRepo(db);
  const rules = new ApportionmentRulesRepo(db);
  accounts.seedIfEmpty();
  rules.seedIfEmpty();
  const entries = new JournalEntriesRepo(db);
  const categories = new HouseholdCategoriesRepo(db);
  const householdRules = new HouseholdRulesRepo(db);
  categories.seedMissing();
  householdRules.seedIfEmpty(categories);
  const classifier = new HouseholdClassifier(householdRules, categories);
  const ledger = new JournalLedger({ db, rules, accounts, entries, classifier });
  return { db, txs, accounts, rules, entries, categories, classifier, ledger };
}

function seedTx(txs: TransactionsRepo, date: string, payee: string, amount: number) {
  return txs.insertOne({
    date, amount_in: null, amount_out: amount, currency: "JPY", fx_amount: null, fx_currency: null,
    description: payee, payee, source: "credit-card", source_id: `${date}|${amount}|${payee}`, account: "UFJクレカ", metadata: {},
  });
}

describe("JournalLedger.rebuild", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("取引から仕訳行を生成し、 家計行に費目が付く", () => {
    seedTx(s.txs, "2025-01-10", "NOTION LABS INC.", 14_679);        // 100% 26
    seedTx(s.txs, "2025-01-11", "ａｕ電話利用料", 6_756);              // 70% 12
    seedTx(s.txs, "2025-01-12", "セブン-イレブン 中目黒", 800);        // 家計 → コンビニ
    const r = s.ledger.rebuild(2025);
    expect(r.generated).toBe(4);
    const rows = s.entries.listYear(2025);
    expect(rows.map((e) => e.no)).toEqual([1, 2, 3, 4]);
    const household = rows.filter((e) => e.leg === "household");
    expect(household).toHaveLength(2);
    const konbini = household.find((e) => e.source_tx_id !== null && e.payment === 800)!;
    expect(s.classifier.categoryName(konbini.household_category_id)).toBe("食費(コンビニ)");
    const au = household.find((e) => e.payment === 6_756)!;
    expect(au.debit_amount).toBe(6_756 - Math.round(6_756 * 0.7));
  });

  it("再生成は冪等で、 手動仕訳と locked 行は保持される", () => {
    seedTx(s.txs, "2025-02-01", "NOTION LABS INC.", 1_000);
    s.ledger.rebuild(2025);
    const manual = buildManualEntries({ template: "sales_with_withholding", fiscal_year: 2025, entry_date: "2025-02-05", amount: 100_000, description: "MELPOT" });
    for (const m of manual) s.entries.insert(m);
    const auto = s.entries.listYear(2025, { origin: "transaction" })[0]!;
    s.entries.update(auto.id, { debit_code: 17, locked: true });

    seedTx(s.txs, "2025-02-10", "OPENAI", 3_000);
    const r = s.ledger.rebuild(2025);
    expect(r.kept_locked).toBe(1);
    const rows = s.entries.listYear(2025);
    expect(rows.filter((e) => e.origin === "manual")).toHaveLength(2);
    expect(rows.find((e) => e.id === auto.id)!.debit_code).toBe(17);
    expect(rows.filter((e) => e.origin === "transaction")).toHaveLength(2);
    // 2 回目も件数が変わらない
    const again = s.ledger.rebuild(2025);
    expect(again.generated).toBe(1);
    expect(s.entries.listYear(2025)).toHaveLength(4);
  });

  it("年度外の取引は対象にしない", () => {
    seedTx(s.txs, "2024-12-31", "NOTION LABS INC.", 1_000);
    seedTx(s.txs, "2025-01-01", "NOTION LABS INC.", 2_000);
    s.ledger.rebuild(2025);
    expect(s.entries.listYear(2025)).toHaveLength(1);
    expect(s.entries.years()).toEqual([2025]);
  });
});

describe("manual entry templates", () => {
  it("源泉付き売上は 2 行 (当座 / 仮払税金) で合計が総額になる", () => {
    const rows = buildManualEntries({ template: "sales_with_withholding", fiscal_year: 2025, entry_date: "2025-03-01", amount: 100_000, description: "MELPOT" });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.debit_code).toBe(102);
    expect(rows[1]!.debit_code).toBe(117);
    expect(rows[0]!.debit_amount + rows[1]!.debit_amount).toBe(100_000);
    expect(rows[1]!.debit_amount).toBe(10_210);
  });

  it("cash_expense は科目必須、 金額は正の整数", () => {
    expect(() => buildManualEntries({ template: "cash_expense", fiscal_year: 2025, entry_date: "2025-03-01", amount: 500, description: "Suica" })).toThrow();
    expect(() => buildManualEntries({ template: "rent", fiscal_year: 2025, entry_date: "2025-03-01", amount: 0, description: "家賃" })).toThrow();
    const rows = buildManualEntries({ template: "cash_expense", fiscal_year: 2025, entry_date: "2025-03-01", amount: 500, description: "Suica", debit_code: 11 });
    expect(rows[0]).toMatchObject({ debit_code: 11, credit_code: 101, leg: "expense", locked: true });
  });
});
