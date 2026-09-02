import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { CostRulesRepo } from "../src/db/cost-rules-repo.js";
import { JournalEntriesRepo } from "../src/db/journal-entries-repo.js";
import { CostStructureService } from "../src/services/cost-structure/cost-structure.js";
import { coefficientOfVariation, detectRecurring } from "../src/services/cost-structure/recurring-detector.js";
import { monthsEndingAt } from "../src/services/cost-structure/utility-scan.js";
import { buildApp } from "../src/app.js";

function setup() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const txs = new TransactionsRepo(db);
  new AccountCodesRepo(db).seedIfEmpty();
  const apportionment = new ApportionmentRulesRepo(db);
  apportionment.seedIfEmpty();
  const rules = new CostRulesRepo(db);
  rules.seedIfEmpty();
  const entries = new JournalEntriesRepo(db);
  return { db, txs, rules, entries, svc: new CostStructureService({ db, rules, apportionment }) };
}

function seedTx(txs: TransactionsRepo, date: string, payee: string, amount: number) {
  txs.insertOne({ date, amount_in: null, amount_out: amount, currency: "JPY", fx_amount: null, fx_currency: null, description: payee, payee, source: "credit-card", source_id: `${date}|${amount}|${payee}`, account: "UFJクレカ", metadata: {} });
}

describe("cost rules (seed)", () => {
  it("AI / ソフトウェア / 家賃 / 光熱は固定費、 未知は変動費", () => {
    const s = setup();
    expect(s.rules.resolve("OPENAI *CHATGPT SUBSCR")).toMatchObject({ cost_type: "fixed" });
    expect(s.rules.resolve("ＡＮＴＨＲＯＰＩＣ")).toMatchObject({ cost_type: "fixed" });
    expect(s.rules.resolve("NOTION LABS, INC.")).toMatchObject({ cost_type: "fixed" });
    expect(s.rules.resolve("AWS EMEA")).toMatchObject({ cost_type: "fixed" });
    expect(s.rules.resolve("LAWSON")).toEqual({ cost_type: "variable", utility: null, label: null, rule_id: null });
    expect(s.rules.resolve("東京電力エナジーパートナー")).toMatchObject({ cost_type: "fixed", utility: "electric" });
    expect(s.rules.resolve("志木市水道料金・下水道使用料")).toMatchObject({ utility: "water" });
    expect(s.rules.resolve("東京ガス")).toMatchObject({ utility: "gas" });
    expect(s.rules.resolve("サイゼリヤ")).toEqual({ cost_type: "variable", utility: null, label: null, rule_id: null });
  });
});

describe("recurring detector", () => {
  it("3 ヶ月以上・変動係数 25% 以内を固定費候補にする", () => {
    const months = monthsEndingAt("2026-08", 6);
    expect(months).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    const cands = detectRecurring([
      { payee_norm: "CURSOR", payee_sample: "CURSOR", months: new Map([["2026-06", 3_000], ["2026-07", 3_000], ["2026-08", 3_100]]) },
      { payee_norm: "スーパー", payee_sample: "スーパー", months: new Map([["2026-06", 10_000], ["2026-07", 30_000], ["2026-08", 5_000]]) },
      { payee_norm: "単発", payee_sample: "単発", months: new Map([["2026-08", 50_000]]) },
    ], { windowMonths: months });
    expect(cands.map((c) => c.payee_norm)).toEqual(["CURSOR"]);
    expect(cands[0]).toMatchObject({ months_present: 3, months_window: 6, average: 3_033 });
    expect(coefficientOfVariation([])).toBe(Infinity);
    expect(coefficientOfVariation([5, 5, 5])).toBe(0);
  });
});

describe("CostStructureService", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it("固定費 / 変動費の合計と店別、 前期比、 事業分", () => {
    seedTx(s.txs, "2026-08-01", "OPENAI", 3_000);                 // 固定 (按分 100% 事業)
    seedTx(s.txs, "2026-08-02", "東京電力", 8_000);              // 固定 + 電気
    seedTx(s.txs, "2026-08-03", "サイゼリヤ", 1_500);             // 変動
    seedTx(s.txs, "2026-08-10", "サイゼリヤ", 1_200);
    seedTx(s.txs, "2026-07-01", "OPENAI", 3_000);
    const v = s.svc.view("month", "2026-08-15");
    expect(v.totals.fixed).toMatchObject({ amount: 11_000, count: 2, previous: 3_000, business: 3_000 });
    expect(v.totals.variable).toMatchObject({ amount: 2_700, count: 2, previous: 0 });
    expect(v.totals.spend).toBe(13_700);
    expect(v.fixed.map((r) => r.payee_norm)).toEqual(["東京電力", "OPENAI"]);
    expect(v.fixed[1]).toMatchObject({ previous: 3_000, business: 3_000, label: "AI・開発サービス" });
    expect(v.variable[0]).toMatchObject({ payee_norm: "サイゼリヤ", amount: 2_700, count: 2, rule_id: null });
    expect(v.months).toEqual(["2026-08"]);
    expect(v.journal_months_used).toEqual([]);
  });

  it("取引の無い月だけ取込済み仕訳で補い、 按分の 2 行は 1 イベントにする", () => {
    seedTx(s.txs, "2026-08-01", "OPENAI", 3_000);
    const imp = (date: string, desc: string, payment: number, leg: "expense" | "household", debit: number) =>
      s.entries.insert({ fiscal_year: 2026, entry_date: date, debit_code: debit, debit_amount: 1, credit_code: 102, credit_amount: 1, description: desc, payment, rate: 0.5, origin: "imported", leg, locked: true });
    imp("2026-07-05", "ＮＥＴＦＬＩＸ．ＣＯＭ", 2_000, "expense", 26);
    imp("2026-07-05", "ＮＥＴＦＬＩＸ．ＣＯＭ", 2_000, "household", 124);
    imp("2026-07-05", "ＮＥＴＦＬＩＸ．ＣＯＭ", 2_000, "expense", 26);
    imp("2026-07-05", "ＮＥＴＦＬＩＸ．ＣＯＭ", 2_000, "household", 124);
    imp("2026-07-06", "クレカ引き落とし調整", 999, "household", 124);
    imp("2026-08-05", "ＮＥＴＦＬＩＸ．ＣＯＭ", 2_000, "expense", 26); // 8 月は取引があるので使わない
    const v = s.svc.view("quarter", "2026-08-15");
    expect(v.journal_months_used).toEqual(["2026-07"]);
    expect(v.totals.spend).toBe(7_000);
    const nf = v.fixed.find((r) => r.payee_norm === "NETFLIX.COM")!;
    expect(nf).toMatchObject({ amount: 4_000, count: 2 });
  });

  it("水道光熱費スキャン: 月 × 種別と前年同月比", () => {
    seedTx(s.txs, "2025-01-10", "関西電力", 5_000); // 比較用 lookback。表示期間の件数・支払先には含めない
    seedTx(s.txs, "2025-08-10", "東京電力", 7_000);
    seedTx(s.txs, "2026-06-10", "東京電力", 6_000);
    seedTx(s.txs, "2026-07-10", "東京電力", 6_500);
    seedTx(s.txs, "2026-08-10", "東京電力", 8_000);
    seedTx(s.txs, "2026-08-12", "東京ガス", 3_000);
    seedTx(s.txs, "2026-07-15", "志木市水道料金", 4_000);
    seedTx(s.txs, "2026-08-13", "サイゼリヤ", 1_000);
    const u = s.svc.utilities("2026-08-20", 12);
    expect(u.months).toHaveLength(12);
    expect(u.months[11]).toMatchObject({ month: "2026-08", by_kind: { electric: 8_000, gas: 3_000, water: 0 }, total: 11_000 });
    const el = u.kinds.find((k) => k.kind === "electric")!;
    expect(el).toMatchObject({ latest_month: "2026-08", latest_amount: 8_000, previous_year_amount: 7_000, yoy_delta: 1_000, total_12m: 20_500 });
    expect(el.average_12m).toBe(Math.round(20_500 / 3));
    expect(el.payees).toEqual(["東京電力"]);
    const water = u.kinds.find((k) => k.kind === "water")!;
    expect(water).toMatchObject({ latest_month: "2026-07", latest_amount: 4_000, previous_year_amount: null, yoy_delta: null });
    expect(u.events).toBe(5);
  });

  it("固定費候補はルールの無い定期支出だけ", () => {
    for (const m of ["2026-05", "2026-06", "2026-07", "2026-08"]) {
      seedTx(s.txs, `${m}-01`, "CURSOR AI POWERED IDE", 3_000);   // seed で固定 → 候補にしない
      seedTx(s.txs, `${m}-02`, "コメダ珈琲 目黒", 1_000);          // 定期 → 候補
      seedTx(s.txs, `${m}-03`, "ヨドバシカメラ", Number(m.slice(5)) ** 2 * 1_000); // ばらつき大
    }
    const c = s.svc.suggestions("2026-08-20", 6);
    expect(c.map((x) => x.payee_norm)).toEqual(["コメダ珈琲 目黒"]);
  });
});

describe("/v1/cost-structure", () => {
  it("view / utilities / suggestions / apply / rules CRUD", async () => {
    const db = new Database(":memory:");
    const app = buildApp({ db });
    new AccountCodesRepo(db).seedIfEmpty();
    new ApportionmentRulesRepo(db).seedIfEmpty();
    const txs = new TransactionsRepo(db);
    for (const m of ["2026-06", "2026-07", "2026-08"]) seedTx(txs, `${m}-01`, "コメダ珈琲 目黒", 1_000);
    const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const v = await (await app.request("/v1/cost-structure?window=month&anchor=2026-08-15")).json() as { totals: { variable: { amount: number } } };
    expect(v.totals.variable.amount).toBe(1_000);
    expect((await app.request("/v1/cost-structure?window=decade")).status).toBe(400);
    const u = await (await app.request("/v1/cost-structure/utilities?anchor=2026-08-15&months=6")).json() as { months: unknown[] };
    expect(u.months).toHaveLength(6);

    const sug = await (await app.request("/v1/cost-structure/suggestions?anchor=2026-08-15")).json() as { items: { payee_norm: string }[] };
    expect(sug.items.map((i) => i.payee_norm)).toEqual(["コメダ珈琲 目黒"]);
    const applied = await (await app.request("/v1/cost-structure/suggestions/apply", json("POST", { payees: ["コメダ珈琲 目黒"] }))).json() as { created: number; skipped: string[] };
    expect(applied.created).toBe(1);
    const again = await (await app.request("/v1/cost-structure/suggestions/apply", json("POST", { payees: ["コメダ珈琲 目黒"] }))).json() as { created: number; skipped: string[] };
    expect(again).toMatchObject({ created: 0, skipped: ["コメダ珈琲 目黒"] });
    const v2 = await (await app.request("/v1/cost-structure?window=month&anchor=2026-08-15")).json() as { totals: { fixed: { amount: number } } };
    expect(v2.totals.fixed.amount).toBe(1_000);
    expect((await (await app.request("/v1/cost-structure/suggestions?anchor=2026-08-15")).json() as { items: unknown[] }).items).toEqual([]);

    const rules = new CostRulesRepo(db);
    const disabledId = rules.insert({ pattern: "^休眠店$", cost_type: "variable", enabled: false });
    const reactivated = await (await app.request("/v1/cost-structure/suggestions/apply", json("POST", { payees: ["休眠店"] }))).json() as { created: number; reactivated: number; rule_ids: number[] };
    expect(reactivated).toMatchObject({ created: 0, reactivated: 1, rule_ids: [disabledId] });
    expect(rules.find(disabledId)).toMatchObject({ cost_type: "fixed", enabled: 1 });

    expect((await app.request("/v1/cost-structure/rules", json("POST", { pattern: "(", cost_type: "fixed" }))).status).toBe(400);
    expect((await app.request("/v1/cost-structure/rules", json("POST", { pattern: "(A+)+$", cost_type: "fixed" }))).status).toBe(400);
    const created = await app.request("/v1/cost-structure/rules", json("POST", { pattern: "ジム", cost_type: "fixed", label: "ジム" }));
    expect(created.status).toBe(201);
    const id = (await created.json() as { rule: { id: number } }).rule.id;
    expect((await app.request(`/v1/cost-structure/rules/${id}`, json("PATCH", { cost_type: "variable" }))).status).toBe(200);
    expect((await app.request(`/v1/cost-structure/rules/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/v1/cost-structure/rules/abc", { method: "DELETE" })).status).toBe(400);
    expect((await app.request("/v1/cost-structure/rules/9007199254740993", { method: "DELETE" })).status).toBe(400);
  });
});
