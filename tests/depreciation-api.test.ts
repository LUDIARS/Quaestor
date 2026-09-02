import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { buildApp } from "../src/app.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";

function makeApp() {
  const db = new Database(":memory:");
  const app = buildApp({ db });
  new AccountCodesRepo(db).seedIfEmpty();
  new ApportionmentRulesRepo(db).seedIfEmpty();
  return { app, db };
}

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/v1/depreciation", () => {
  let s: ReturnType<typeof makeApp>;
  beforeEach(() => { s = makeApp(); });

  it("台帳 CRUD → 償却表 → 投影 → 仕訳計上 (再計上で増えない) → 精算表に効く", async () => {
    const created = await s.app.request("/v1/depreciation/assets", json("POST", {
      name: "開発用 PC", acquired_on: "2024-07-01", cost: 300_000, method: "straight_line", useful_life: 4, business_ratio: 0.8,
    }));
    expect(created.status).toBe(201);
    const asset = (await created.json() as { asset: { id: number } }).asset;

    const sched = await (await s.app.request("/v1/depreciation/2025/schedule")).json() as { rows: { total: number; expense: number; household: number; closing_book: number }[]; totals: { expense: number } };
    expect(sched.rows).toHaveLength(1);
    expect(sched.rows[0]).toMatchObject({ total: 75_000, expense: 60_000, household: 15_000, closing_book: 187_500 });
    expect(sched.totals.expense).toBe(60_000);

    const proj = await (await s.app.request(`/v1/depreciation/assets/${asset.id}/projection`)).json() as { rows: { year: number }[] };
    expect(proj.rows.map((r) => r.year)).toEqual([2024, 2025, 2026, 2027, 2028]);

    const post1 = await (await s.app.request("/v1/depreciation/2025/post", { method: "POST" })).json() as { posted: number; deleted: number; accounts_added: number };
    expect(post1.posted).toBe(2);
    expect(post1.accounts_added).toBeGreaterThan(0); // 18 減価償却費 / 111〜116 を足した
    const post2 = await (await s.app.request("/v1/depreciation/2025/post", { method: "POST" })).json() as { posted: number; deleted: number };
    expect(post2).toMatchObject({ posted: 2, deleted: 2 });

    const journal = await (await s.app.request("/v1/bookkeeping/2025/journal")).json() as { items: { debit_code: number; credit_code: number; debit_amount: number; asset_id: number | null; description: string }[] };
    expect(journal.items).toHaveLength(2);
    expect(journal.items.map((e) => [e.debit_code, e.credit_code, e.debit_amount])).toEqual([[18, 115, 60_000], [124, 115, 15_000]]);
    expect(journal.items.every((e) => e.asset_id === asset.id)).toBe(true);

    // 期首簿価 262,500 を入れると 期末 = 187,500
    await s.app.request("/v1/bookkeeping/2025/opening", json("PUT", { balances: [{ code: 115, amount: 262_500 }] }));
    const tb = await (await s.app.request("/v1/bookkeeping/2025/trial-balance")).json() as { rows: { code: number; bs_debit: number; pl_debit: number }[] };
    expect(tb.rows.find((r) => r.code === 115)!.bs_debit).toBe(187_500);
    expect(tb.rows.find((r) => r.code === 18)!.pl_debit).toBe(60_000);

    // ブックに「減価償却」シートが出る
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await s.app.request("/v1/bookkeeping/2025/workbook.xlsx")).arrayBuffer() as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toContain("減価償却");
    expect(wb.getWorksheet("減価償却")!.getCell("B5").value).toBe("開発用 PC");

    const patched = await s.app.request(`/v1/depreciation/assets/${asset.id}`, json("PATCH", { disposed_on: "2025-06-30" }));
    expect(patched.status).toBe(200);
    const sched2 = await (await s.app.request("/v1/depreciation/2025/schedule")).json() as { rows: { months: number; total: number }[] };
    expect(sched2.rows[0]).toMatchObject({ months: 6, total: 37_500 });

    expect((await s.app.request(`/v1/depreciation/assets/${asset.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await s.app.request(`/v1/depreciation/assets/${asset.id}`)).status).toBe(404);
    const afterDelete = await (await s.app.request("/v1/bookkeeping/2025/journal")).json() as { items: unknown[] };
    expect(afterDelete.items).toHaveLength(0); // 資産と、その資産から自動計上した仕訳を一緒に削除する
  });

  it("入力検証: 耐用年数の範囲 / 期首簿価と年のセット / 不正な日付", async () => {
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-01-01", cost: 1, method: "straight_line", useful_life: 1 }))).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-01-01", cost: 1, method: "straight_line", useful_life: 4, opening_year: 2025 }))).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-02-30", cost: 1, method: "immediate" }))).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-02-29", disposed_on: "2024-02-28", cost: 1, method: "immediate" }))).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-02-29", cost: 1, method: "immediate", opening_year: 2023, opening_book_value: 1 }))).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-02-29", cost: 1, method: "straight_line", useful_life: 4, opening_year: 2024, opening_book_value: 1, revised_cost: 1 }))).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-02-29", cost: 1, method: "immediate", asset_code: 9999 }))).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets", json("POST", { name: "x", acquired_on: "2024-02-29", cost: 1, method: "immediate" }))).status).toBe(201);
    expect((await s.app.request("/v1/depreciation/abc/schedule")).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/2025oops/schedule")).status).toBe(400);
    expect((await s.app.request("/v1/depreciation/assets/1oops")).status).toBe(400);
    const rates = await (await s.app.request("/v1/depreciation/rates")).json() as { methods: string[]; rates: unknown[] };
    expect(rates.methods).toContain("declining_balance");
    expect(rates.rates).toHaveLength(49);
  });
});
