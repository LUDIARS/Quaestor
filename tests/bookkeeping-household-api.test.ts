import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";

function makeApp() {
  const db = new Database(":memory:");
  new AccountCodesRepo(db); // schema は buildApp 内 applyMigrations で作られる想定のため、 ここでは参照だけ
  const app = buildApp({ db });
  const txs = new TransactionsRepo(db);
  new AccountCodesRepo(db).seedIfEmpty();
  new ApportionmentRulesRepo(db).seedIfEmpty();
  return { app, db, txs };
}

function seedTx(txs: TransactionsRepo, date: string, payee: string, amount: number) {
  return txs.insertOne({
    date, amount_in: null, amount_out: amount, currency: "JPY", fx_amount: null, fx_currency: null,
    description: payee, payee, source: "credit-card", source_id: `${date}|${amount}|${payee}`, account: "UFJクレカ", metadata: {},
  });
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/v1/bookkeeping", () => {
  let s: ReturnType<typeof makeApp>;
  beforeEach(() => { s = makeApp(); });

  it("rebuild → journal → trial-balance → report → workbook が一気通貫で通る", async () => {
    seedTx(s.txs, "2025-04-01", "NOTION LABS INC.", 14_679);
    seedTx(s.txs, "2025-04-02", "セブン-イレブン", 800);
    const rebuild = await s.app.request("/v1/bookkeeping/2025/rebuild", { method: "POST" });
    expect(rebuild.status).toBe(200);
    expect((await rebuild.json() as { generated: number }).generated).toBe(2);

    const manual = await s.app.request("/v1/bookkeeping/2025/journal", json({ template: "sales_with_withholding", entry_date: "2025-04-25", amount: 100_000, description: "MELPOT" }));
    expect(manual.status).toBe(201);

    const journal = await s.app.request("/v1/bookkeeping/2025/journal?month=4");
    const jj = await journal.json() as { items: { id: number; no: number; origin: string; household_category_name: string | null }[] };
    expect(jj.items).toHaveLength(4);
    expect(jj.items.map((i) => i.no)).toEqual([1, 2, 3, 4]);
    expect(jj.items.find((i) => i.household_category_name === "食費(コンビニ)")).toBeTruthy();

    const patch = await s.app.request(`/v1/bookkeeping/journal/${jj.items[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rate: 0.5 }) });
    expect(patch.status).toBe(200);
    expect((await patch.json() as { entry: { locked: number } }).entry.locked).toBe(1);

    const tb = await s.app.request("/v1/bookkeeping/2025/trial-balance");
    const tbj = await tb.json() as { income: number; total: { pl_debit: number; pl_credit: number } };
    expect(tbj.income).toBe(100_000 - 14_679);
    expect(tbj.total.pl_debit).toBe(tbj.total.pl_credit);

    const opening = await s.app.request("/v1/bookkeeping/2025/opening", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ balances: [{ code: 102, amount: 300_000 }] }) });
    expect(opening.status).toBe(200);
    const report = await s.app.request("/v1/bookkeeping/2025/report");
    const rj = await report.json() as { pl: { income: number }; bs: { balanced: boolean; assets_opening_total: number } };
    expect(rj.bs.assets_opening_total).toBe(300_000);
    expect(rj.bs.balanced).toBe(true);

    const ledger = await s.app.request("/v1/bookkeeping/2025/ledger/102");
    expect(ledger.status).toBe(200);
    expect((await ledger.json() as { opening: number }).opening).toBe(300_000);
    expect((await s.app.request("/v1/bookkeeping/2025/ledger/9999")).status).toBe(404);

    const monthly = await s.app.request("/v1/bookkeeping/2025/monthly");
    expect((await monthly.json() as { monthly_sales: number[] }).monthly_sales[3]).toBe(100_000);

    const wb = await s.app.request("/v1/bookkeeping/2025/workbook.xlsx");
    expect(wb.status).toBe(200);
    expect(wb.headers.get("content-type")).toContain("spreadsheetml");
    expect((await wb.arrayBuffer()).byteLength).toBeGreaterThan(1_000);

    const years = await s.app.request("/v1/bookkeeping/years");
    expect((await years.json() as { years: number[] }).years).toEqual([2025]);
  });

  it("入力検証: 不正な年 / テンプレ / base64", async () => {
    expect((await s.app.request("/v1/bookkeeping/abc/rebuild", { method: "POST" })).status).toBe(400);
    expect((await s.app.request("/v1/bookkeeping/2025x/rebuild", { method: "POST" })).status).toBe(400);
    expect((await s.app.request("/v1/bookkeeping/2025/journal", json({ template: "nope", entry_date: "2025-01-01", amount: 1, description: "x" }))).status).toBe(400);
    expect((await s.app.request("/v1/bookkeeping/2025/journal", json({ template: "cash_expense", entry_date: "2025-01-01", amount: 1, description: "x" }))).status).toBe(400);
    expect((await s.app.request("/v1/bookkeeping/2025/journal", json({ template: "custom", entry_date: "2025-02-29", amount: 1, description: "x", debit_code: 102, credit_code: 1 }))).status).toBe(400);
    expect((await s.app.request("/v1/bookkeeping/2025/journal", json({ template: "custom", entry_date: "2026-01-01", amount: 1, description: "x", debit_code: 102, credit_code: 1 }))).status).toBe(400);
    expect((await s.app.request("/v1/bookkeeping/2025/journal", json({ template: "custom", entry_date: "2025-01-01", amount: 1, description: "x", debit_code: 999_999, credit_code: 1 }))).status).toBe(400);
    expect((await s.app.request("/v1/bookkeeping/import-journal", json({ content_b64: "bm90IGEgeGxzeA==" }))).status).toBe(422);
  });

  it("canonical journal は不均衡な更新を拒否する", async () => {
    const created = await s.app.request("/v1/bookkeeping/2025/journal", json({
      template: "custom", entry_date: "2025-01-01", amount: 100, description: "x", debit_code: 102, credit_code: 1,
    }));
    expect(created.status).toBe(201);
    const id = (await created.json() as { entries: { id: number }[] }).entries[0]!.id;
    const patch = await s.app.request(`/v1/bookkeeping/journal/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ debit_amount: 200 }),
    });
    expect(patch.status).toBe(400);
    const journal = await (await s.app.request("/v1/bookkeeping/2025/journal")).json() as { items: { debit_amount: number; credit_amount: number }[] };
    expect(journal.items[0]).toMatchObject({ debit_amount: 100, credit_amount: 100 });
  });
});

describe("/v1/household", () => {
  let s: ReturnType<typeof makeApp>;
  beforeEach(() => { s = makeApp(); });

  it("analysis は window 指定で動き、 不正 window は 400", async () => {
    seedTx(s.txs, "2026-08-03", "セブン-イレブン", 600);
    const r = await s.app.request("/v1/household/analysis?window=month&anchor=2026-08-15");
    expect(r.status).toBe(200);
    const j = await r.json() as { window: { label: string }; totals: { current: { spend: number } } };
    expect(j.window.label).toBe("2026-08");
    expect(j.totals.current.spend).toBe(600);
    expect((await s.app.request("/v1/household/analysis?window=decade")).status).toBe(400);
    expect((await s.app.request("/v1/household/analysis?window=month&anchor=2026-02-31")).status).toBe(400);
    const w = await s.app.request("/v1/household/windows");
    expect((await w.json() as { windows: string[] }).windows).toEqual(["week", "month", "quarter", "half", "year"]);
  });

  it("費目とルールの CRUD、 classify", async () => {
    const cats = await (await s.app.request("/v1/household/categories")).json() as { items: { id: number; name: string }[] };
    expect(cats.items.some((c) => c.name === "その他")).toBe(true);
    const created = await s.app.request("/v1/household/categories", json({ name: "ペット" }));
    expect(created.status).toBe(201);
    const cat = (await created.json() as { category: { id: number } }).category;
    expect((await s.app.request("/v1/household/categories", json({ name: "ペット" }))).status).toBe(409);

    const badRule = await s.app.request("/v1/household/rules", json({ pattern: "(", category_id: cat.id }));
    expect(badRule.status).toBe(400);
    const unsafeRule = await s.app.request("/v1/household/rules", json({ pattern: "(a+)+$", category_id: cat.id }));
    expect(unsafeRule.status).toBe(400);
    const rule = await s.app.request("/v1/household/rules", json({ pattern: "ペットショップ", category_id: cat.id, priority: 5 }));
    expect(rule.status).toBe(201);
    const ruleId = (await rule.json() as { rule: { id: number } }).rule.id;

    const cls = await (await s.app.request("/v1/household/classify", json({ payee: "ペットショップ コジマ" }))).json() as { category_name: string; rule_id: number };
    expect(cls).toMatchObject({ category_name: "ペット", rule_id: ruleId });
    const fallback = await (await s.app.request("/v1/household/classify", json({ payee: "謎の店" }))).json() as { category_name: string; rule_id: null };
    expect(fallback).toMatchObject({ category_name: "その他", rule_id: null });

    expect((await s.app.request(`/v1/household/rules/${ruleId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await s.app.request(`/v1/household/rules/${ruleId}`, { method: "DELETE" })).status).toBe(200);
    expect((await s.app.request(`/v1/household/categories/${cat.id}`, { method: "DELETE" })).status).toBe(200);
  });
});

describe("/v1/apportionment-sheet", () => {
  it("collect → sheet → synthesize (dry-run / apply)", async () => {
    const s = makeApp();
    seedTx(s.txs, "2026-02-05", "コメダ珈琲 目黒", 800);
    await s.app.request("/v1/bookkeeping/2026/rebuild", { method: "POST" });
    const journal = await (await s.app.request("/v1/bookkeeping/2026/journal")).json() as { items: { id: number }[] };
    // 家計に落ちた行を 会議費 100% に手直し → locked → 観測になる
    await s.app.request(`/v1/bookkeeping/journal/${journal.items[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ debit_code: 28, rate: 1 }) });
    const collect = await s.app.request("/v1/apportionment-sheet/collect", { method: "POST" });
    expect((await collect.json() as { observations: number }).observations).toBe(1);

    const sheet = await (await s.app.request("/v1/apportionment-sheet?year=2026")).json() as { rows: { payee_norm: string; status: string }[]; counts: Record<string, number> };
    expect(sheet.rows.find((r) => r.payee_norm === "コメダ珈琲 目黒")!.status).toBe("proposal");
    expect(sheet.counts.proposal).toBe(1);

    const dry = await (await s.app.request("/v1/apportionment-sheet/synthesize", json({ year: 2026, dry_run: true }))).json() as { created: number; candidates: { action: string }[] };
    expect(dry.created).toBe(0);
    expect(dry.candidates.filter((c) => c.action === "create")).toHaveLength(1);
    const apply = await (await s.app.request("/v1/apportionment-sheet/synthesize", json({ year: 2026, dry_run: false }))).json() as { created: number };
    expect(apply.created).toBe(1);
    const resolved = await (await s.app.request("/v1/apportionment-rules/resolve", json({ payee: "コメダ珈琲 目黒" }))).json() as { rate: number; code: number };
    expect(resolved).toMatchObject({ rate: 1, code: 28 });
  });
});
