import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { applyMigrations } from "../src/db/schema.js";
import { HoldingsRepo } from "../src/db/holdings-repo.js";
import { HoldingValuationsRepo } from "../src/db/holding-valuations-repo.js";
import {
  buildPortfolioSnapshot,
  normalizeAdvice,
  ClaudeAllocationAdvisor,
  type AllocationAdvisor,
} from "../src/services/allocation-advisor.js";
import type { HoldingSummary, PortfolioTotals } from "../src/services/portfolio-service.js";
import { buildApp } from "../src/app.js";

let n = 0;
const tmp = () => join(tmpdir(), `quaestor-alloc-${process.pid}-${++n}.json`);

function hs(kind: string, wrapper: string | null, value: number, monthly: number | null): HoldingSummary {
  return {
    holding: {
      id: `h${value}`, kind: kind as never, name: `${kind}-${value}`, account: null, ticker: null, fund_code: null,
      currency: "JPY", tax_wrapper: wrapper as never, target_amount: null, monthly_contribution: monthly,
      status: "active", started_at: null, notes: null, metadata: null, created_at: 0, updated_at: 0,
    },
    latest_valuation: { id: 1, holding_id: `h${value}`, as_of: "2026-06-01", market_value: value, unit_price: null, units: null, fx_rate: null, source: "manual", note: null, created_at: 0 } as never,
    ret: { invested: value, market_value: value, dividends_received: 0 } as never,
  };
}
const totals: PortfolioTotals = {
  count: 0, invested: 0, market_value: 0, valued_invested: 0, unrealized_pl: 50000,
  dividends_received: 0, simple_return_pct: null, planned_to_date: 0, actual_to_date: 0, variance: 0, monthly_contribution: 30000,
};

describe("buildPortfolioSnapshot", () => {
  it("資産クラス別・税制枠別の配分%を集計", () => {
    const data = {
      holdings: [hs("fund", "nisa_tsumitate", 600000, 30000), hs("stock", "taxable", 300000, null), hs("etf", "nisa_growth", 100000, null)],
      totals,
    };
    const snap = buildPortfolioSnapshot("2026-06-01", data);
    expect(snap.totalValue).toBe(1_000_000);
    const fund = snap.byKind.find((s) => s.label === "投資信託")!;
    expect(fund.pct).toBeCloseTo(60, 5);
    expect(snap.byKind[0]!.label).toBe("投資信託"); // value 降順
    expect(snap.byTaxWrapper.some((s) => s.label === "NISА積立")).toBe(true);
    expect(snap.holdings).toHaveLength(3);
    expect(snap.monthlyContribution).toBe(30000);
  });
  it("評価額が無い holding は invested で代替", () => {
    const noVal = { ...hs("fund", null, 0, null), latest_valuation: null, ret: { invested: 200000, market_value: null, dividends_received: 0 } as never };
    const snap = buildPortfolioSnapshot("2026-06-01", { holdings: [noVal], totals });
    expect(snap.totalValue).toBe(200000);
  });
});

describe("normalizeAdvice", () => {
  it("LLM 出力を型に整形 (action 既定 hold、 pct clamp)", () => {
    const a = normalizeAdvice({
      summary: "現金過多",
      target_allocation: [{ asset_class: "先進国株", current_pct: 10, target_pct: 150, action: "bogus", rationale: "増やす" }],
      investment_capacity: { suggested_monthly: 50000.4, note: "余力あり" },
      asset_ideas: [{ name: "全世界株インデックス", kind: "投資信託", tax_wrapper: "NISA", rationale: "低コスト分散" }],
    }, "balanced");
    expect(a.summary).toBe("現金過多");
    expect(a.risk_profile).toBe("balanced");
    expect(a.target_allocation[0]!.target_pct).toBe(100); // clamp
    expect(a.target_allocation[0]!.action).toBe("hold"); // bogus→hold
    expect(a.investment_capacity.suggested_monthly).toBe(50000); // round
    expect(a.asset_ideas[0]!.name).toContain("全世界株");
  });
  it("壊れた出力でも落ちない", () => {
    const a = normalizeAdvice(null, "aggressive");
    expect(a.target_allocation).toEqual([]);
    expect(a.risk_profile).toBe("aggressive");
  });
});

describe("ClaudeAllocationAdvisor — runner 注入", () => {
  it("runner の JSON を正規化して返す", async () => {
    const advisor = new ClaudeAllocationAdvisor({
      runner: async () => ({ summary: "S", target_allocation: [], investment_capacity: { suggested_monthly: 10000, note: "n" }, asset_ideas: [] }),
    });
    const snap = buildPortfolioSnapshot("2026-06-01", { holdings: [hs("fund", "nisa_tsumitate", 100000, 10000)], totals });
    const a = await advisor.recommend(snap, { risk: "conservative" });
    expect(a.summary).toBe("S");
    expect(a.risk_profile).toBe("conservative");
    expect(a.investment_capacity.suggested_monthly).toBe(10000);
  });
});

const fakeAdvisor: AllocationAdvisor = {
  async recommend(_snap, profile) {
    return {
      summary: "テスト提案", risk_profile: profile?.risk ?? "balanced",
      target_allocation: [{ asset_class: "先進国株", current_pct: 30, target_pct: 50, action: "increase", rationale: "成長" }],
      investment_capacity: { suggested_monthly: 40000, note: "NISA枠活用" },
      asset_ideas: [{ name: "全世界株インデックス", kind: "投資信託", tax_wrapper: "NISAつみたて", rationale: "分散・低コスト" }],
    };
  },
};

describe("API: /v1/portfolio/allocation", () => {
  function appWith(path: string, advisor: AllocationAdvisor | "disabled") {
    const db = new Database(":memory:");
    applyMigrations(db);
    // holding を 1 件作って評価額を入れる
    const holdings = new HoldingsRepo(db);
    const vals = new HoldingValuationsRepo(db);
    const h = holdings.create({ kind: "fund", name: "eMAXIS", tax_wrapper: "nisa_tsumitate", monthly_contribution: 30000 });
    vals.upsert({ holding_id: h.id, as_of: "2026-06-01", market_value: 500000, source: "manual" });
    return buildApp({ db, receiptsRoot: "/tmp/qa", ocr: "disabled", allocationAdvisor: advisor, allocationAdvicePath: path });
  }

  it("recommend → GET allocation でキャッシュ取得", async () => {
    const path = tmp();
    const app = appWith(path, fakeAdvisor);
    const rec = await app.request("/v1/portfolio/allocation/recommend", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ risk: "aggressive", goal: "20年で2000万" }),
    });
    expect(rec.status).toBe(200);
    const rj = await rec.json() as { advice: { summary: string }; snapshot: { totalValue: number } };
    expect(rj.advice.summary).toBe("テスト提案");
    expect(rj.snapshot.totalValue).toBe(500000);

    const get = await (await app.request("/v1/portfolio/allocation")).json() as { available: boolean; advice: { summary: string } };
    expect(get.available).toBe(true);
    expect(get.advice.summary).toBe("テスト提案");
    rmSync(path, { force: true });
  });

  it("advisor 無効なら disabled", async () => {
    const path = tmp();
    const app = appWith(path, "disabled");
    const r = await app.request("/v1/portfolio/allocation/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await r.json() as { disabled: boolean }).disabled).toBe(true);
    rmSync(path, { force: true });
  });

  it("保有ゼロなら 400", async () => {
    const path = tmp();
    const app = buildApp({ db: (() => { const d = new Database(":memory:"); applyMigrations(d); return d; })(), receiptsRoot: "/tmp/qa2", ocr: "disabled", allocationAdvisor: fakeAdvisor, allocationAdvicePath: path });
    const r = await app.request("/v1/portfolio/allocation/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
    rmSync(path, { force: true });
  });
});
