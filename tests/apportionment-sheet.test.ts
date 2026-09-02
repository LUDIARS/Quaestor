import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { JournalEntriesRepo } from "../src/db/journal-entries-repo.js";
import { ApportionmentObservationsRepo } from "../src/db/apportionment-observations-repo.js";
import { ObservationCollector } from "../src/services/apportionment-sheet/observation-collector.js";
import { buildApportionmentSheet, collectYearSpend } from "../src/services/apportionment-sheet/sheet-builder.js";
import { exactPattern, synthesizeRules } from "../src/services/apportionment-sheet/rule-synthesizer.js";
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
  const observations = new ApportionmentObservationsRepo(db);
  const collector = new ObservationCollector(entries, observations, (id) => txs.find(id)?.payee ?? null);
  return { db, txs, rules, entries, observations, collector };
}

function seedTx(txs: TransactionsRepo, date: string, payee: string, amount: number) {
  return txs.insertOne({
    date, amount_in: null, amount_out: amount, currency: "JPY", fx_amount: null, fx_currency: null,
    description: payee, payee, source: "credit-card", source_id: `${date}|${amount}|${payee}`, account: "UFJクレカ", metadata: {},
  });
}

describe("apportionment sheet", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("観測は人が決めた行 (manual / locked) だけから作られる", () => {
    const txId = seedTx(s.txs, "2026-03-01", "ヨドバシカメラ 新宿", 5_000);
    // 未編集の自動生成行 (観測にしない)
    s.entries.insert({ fiscal_year: 2026, entry_date: "2026-03-01", debit_code: 26, debit_amount: 5_000, credit_code: 102, credit_amount: 5_000, description: "ヨドバシカメラ 新宿", payment: 5_000, rate: 1, origin: "transaction", leg: "expense", source_tx_id: txId });
    // 手で直した自動生成行 (観測にする、 payee は取引から引く)
    const tx2 = seedTx(s.txs, "2026-03-02", "コメダ珈琲 目黒", 1_200);
    s.entries.insert({ fiscal_year: 2026, entry_date: "2026-03-02", debit_code: 28, debit_amount: 1_200, credit_code: 102, credit_amount: 1_200, description: "会議", payment: 1_200, rate: 1, origin: "transaction", leg: "expense", source_tx_id: tx2, locked: true });
    // 手動仕訳
    for (const m of buildManualEntries({ template: "cash_expense", fiscal_year: 2026, entry_date: "2026-03-03", amount: 500, description: "Suica", debit_code: 11 })) s.entries.insert(m);
    const r = s.collector.rebuildLedger();
    expect(r.observations).toBe(2);
    const obs = s.observations.list();
    expect(obs.map((o) => [o.payee_norm, o.rate, o.code])).toEqual(expect.arrayContaining([["コメダ珈琲 目黒", 1, 28], ["SUICA", 1, 11]]));
    expect(obs.find((o) => o.payee_norm.startsWith("ヨドバシ"))).toBeUndefined();
    // 再構築で増えない
    s.collector.rebuildLedger();
    expect(s.observations.count()).toBe(2);
  });

  it("シートは 提案 / 不一致 / 判断待ち / 一致 に分類し、 当年支出を付ける", () => {
    seedTx(s.txs, "2026-01-05", "コメダ珈琲 目黒", 1_200);
    seedTx(s.txs, "2026-02-05", "コメダ珈琲 目黒", 800);
    seedTx(s.txs, "2026-02-06", "NOTION LABS INC.", 14_679);     // seed ルールで 100%/26
    seedTx(s.txs, "2026-02-07", "謎の店", 300);                    // 観測もルールも無い
    s.observations.addMany([
      { fiscal_year: 2025, payee_norm: "コメダ珈琲 目黒", payee_sample: "コメダ珈琲 目黒", rate: 1, code: 28, amount: 1_200, date: "2025-05-01", source: "journal-xlsx" },
      { fiscal_year: 2025, payee_norm: "コメダ珈琲 目黒", payee_sample: "コメダ珈琲 目黒", rate: 1, code: 28, amount: 900, date: "2025-06-01", source: "ledger" },
      { fiscal_year: 2025, payee_norm: "コメダ珈琲 目黒", payee_sample: "コメダ珈琲 目黒", rate: 0, code: 124, amount: 500, date: "2025-04-01", source: "journal-xlsx" },
      { fiscal_year: 2025, payee_norm: "NOTION LABS INC.", payee_sample: "NOTION LABS INC.", rate: 1, code: 26, amount: 14_679, date: "2025-05-01", source: "journal-xlsx" },
      { fiscal_year: 2025, payee_norm: "NETFLIX.COM", payee_sample: "NETFLIX.COM", rate: 1, code: 26, amount: 2_000, date: "2025-05-01", source: "journal-xlsx" }, // seed は 50%
    ]);
    const sheet = buildApportionmentSheet(s.observations.list(), s.rules, collectYearSpend(s.db, 2026));
    const by = new Map(sheet.map((r) => [r.payee_norm, r]));
    const komeda = by.get("コメダ珈琲 目黒")!;
    expect(komeda.status).toBe("proposal");
    expect(komeda.proposed).toEqual({ rate: 1, code: 28, occurrences: 2 });
    expect(komeda.observations[0]!.sources.sort()).toEqual(["journal-xlsx", "ledger"]);
    expect(komeda.spend_in_year).toBe(2_000);
    expect(komeda.tx_count_in_year).toBe(2);
    expect(by.get("NOTION LABS INC.")!.status).toBe("match");
    expect(by.get("NETFLIX.COM")!.status).toBe("differs");
    expect(by.get("謎の店")!.status).toBe("unknown");
    expect(sheet.map((r) => r.status)).toEqual(["proposal", "differs", "unknown", "match"]);
  });

  it("dry-run は作らず、 apply で proposal だけルール化する。 differs は override 時のみ", () => {
    s.observations.addMany([
      { fiscal_year: 2025, payee_norm: "コメダ珈琲 目黒", payee_sample: "コメダ珈琲 目黒", rate: 1, code: 28, amount: 1_200, date: "2025-05-01", source: "ledger" },
      { fiscal_year: 2025, payee_norm: "NETFLIX.COM", payee_sample: "NETFLIX.COM", rate: 1, code: 26, amount: 2_000, date: "2025-05-01", source: "ledger" },
    ]);
    const before = s.rules.list(true).length;
    const sheet = () => buildApportionmentSheet(s.observations.list(), s.rules, new Map());

    const dry = synthesizeRules(sheet(), s.rules, { dry_run: true, today: "2026-09-03" });
    expect(dry.created).toBe(0);
    expect(dry.candidates.map((c) => [c.payee_norm, c.action])).toEqual(expect.arrayContaining([["コメダ珈琲 目黒", "create"], ["NETFLIX.COM", "skip"]]));
    expect(s.rules.list(true)).toHaveLength(before);

    const applied = synthesizeRules(sheet(), s.rules, { dry_run: false, today: "2026-09-03" });
    expect(applied.created).toBe(1);
    const created = s.rules.find(applied.candidates.find((c) => c.action === "create")!.rule_id!)!;
    expect(created).toMatchObject({ pattern: exactPattern("コメダ珈琲 目黒"), rate: 1, code: 28, priority: 300, note: "sheet:2026-09-03" });
    expect(s.rules.resolve("コメダ珈琲　目黒")).toMatchObject({ rate: 1, code: 28, rule_id: created.id });

    // 2 回目: 既に一致なので skip
    const again = synthesizeRules(sheet(), s.rules, { dry_run: false, today: "2026-09-03" });
    expect(again.created).toBe(0);

    // override: NETFLIX を 100% に上書き (既存 seed より小さい priority)
    const ov = synthesizeRules(sheet(), s.rules, { dry_run: false, override: true, today: "2026-09-03" });
    expect(ov.created).toBe(1);
    expect(s.rules.resolve("NETFLIX.COM").rate).toBe(1);
  });

  it("正規表現の特殊文字はエスケープされる", () => {
    expect(exactPattern("PAYPAL *MICROSOFT (JP)")).toBe("^PAYPAL \\*MICROSOFT \\(JP\\)$");
    expect(new RegExp(exactPattern("A.B+C"), "i").test("A.B+C")).toBe(true);
    expect(new RegExp(exactPattern("A.B+C"), "i").test("AXBBC")).toBe(false);
  });

  it("disabled の完全一致ルールは新しい提案の生成を妨げない", () => {
    const payee = "無効ルール店";
    s.rules.insert({ pattern: exactPattern(payee), rate: 0.5, code: 26, enabled: false });
    s.observations.add({
      fiscal_year: 2025, payee_norm: payee, payee_sample: payee,
      rate: 1, code: 28, amount: 1_000, date: "2025-01-01", source: "ledger",
    });
    const result = synthesizeRules(
      buildApportionmentSheet(s.observations.list(), s.rules, new Map()),
      s.rules,
      { dry_run: false, today: "2026-09-03" },
    );
    expect(result.created).toBe(1);
    expect(s.rules.resolve(payee)).toMatchObject({ rate: 1, code: 28 });
  });

  it("override は既存の完全一致ルールを重複させず更新する", () => {
    const payee = "完全一致店";
    const id = s.rules.insert({ pattern: exactPattern(payee), rate: 0.5, code: 26, priority: 300 });
    s.observations.add({
      fiscal_year: 2025, payee_norm: payee, payee_sample: payee,
      rate: 1, code: 28, amount: 1_000, date: "2025-01-01", source: "ledger",
    });
    const before = s.rules.list(true).length;
    const result = synthesizeRules(
      buildApportionmentSheet(s.observations.list(), s.rules, new Map()),
      s.rules,
      { dry_run: false, override: true, today: "2026-09-03" },
    );
    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(s.rules.list(true)).toHaveLength(before);
    expect(s.rules.find(id)).toMatchObject({ rate: 1, code: 28, note: "sheet:2026-09-03" });
  });
});
