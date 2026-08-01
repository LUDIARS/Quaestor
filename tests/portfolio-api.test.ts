import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import type { StockClient, PriceHistory } from "../src/services/stock-client.js";
import type { DividendClient, DividendData } from "../src/services/dividend-client.js";

// ── fakes ──

class FakeStock implements StockClient {
  async history(ticker: string): Promise<PriceHistory | null> {
    if (ticker !== "7203") return null;
    return {
      ticker,
      as_of: "2025-04-30",
      bars: [
        { date: "2025-04-01", close: 2500 },
        { date: "2025-04-30", close: 3000 },
      ],
    };
  }
}

class FakeDividend implements DividendClient {
  async fetch(ticker: string): Promise<DividendData> {
    return {
      dividend_yield_pct: 2.5,
      dps_annual: 75,
      payout_ratio_pct: 30,
      consecutive_increase_years: 5,
      ex_rights_months: [3, 9],
      stability_note: "累進配当方針。最新は IR 要確認",
      rationale: "連続増配と低めの配当性向",
    };
  }
}

describe("API: /v1/portfolio (real sqlite)", () => {
  let app: ReturnType<typeof buildApp>;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    app = buildApp({
      db,
      receiptsRoot: "/tmp/qportfolio",
      ocr: "disabled",
      securityMapper: "disabled",
      perkClient: "disabled",
      stockClient: new FakeStock(),
      dividendClient: new FakeDividend(),
      planReviewer: "disabled",
    });
  });

  function post(path: string, body: unknown = {}) {
    return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  it("migrations create the portfolio tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "holdings",
        "contributions",
        "holding_valuations",
        "holding_dividends",
        "dividend_candidates",
      ]),
    );
    expect(db.pragma("user_version", { simple: true })).toBe(9);
  });

  it("creates a fund holding, records contributions + valuation, computes return", async () => {
    const created = await (await post("/v1/portfolio/holdings", {
      kind: "fund",
      name: "eMAXIS Slim 全世界株式",
      account: "SBI つみたてNISA",
      tax_wrapper: "nisa_tsumitate",
      monthly_contribution: 33333,
      started_at: "2024-01-01",
    })).json() as { holding: { id: string } };
    const id = created.holding.id;
    expect(id).toBeTruthy();

    await post(`/v1/portfolio/holdings/${id}/contributions`, { date: "2024-01-05", amount: 33333, kind: "actual" });
    await post(`/v1/portfolio/holdings/${id}/contributions`, { date: "2024-02-05", amount: 33333, kind: "actual" });
    await post(`/v1/portfolio/holdings/${id}/valuations`, { as_of: "2024-03-01", market_value: 75000 });

    const detail = await (await app.request(`/v1/portfolio/holdings/${id}?as_of=2024-03-01`)).json() as {
      ret: { invested: number; unrealized_pl: number; market_value: number };
      contributions: unknown[];
      valuations: unknown[];
    };
    expect(detail.contributions).toHaveLength(2);
    expect(detail.valuations).toHaveLength(1);
    expect(detail.ret.invested).toBe(66666);
    expect(detail.ret.market_value).toBe(75000);
    expect(detail.ret.unrealized_pl).toBe(8334);
  });

  it("refreshes stock/etf valuations from stooq and skips funds", async () => {
    // stock holding with explicit units
    const stock = await (await post("/v1/portfolio/holdings", {
      kind: "stock", name: "トヨタ自動車", ticker: "7203",
    })).json() as { holding: { id: string } };
    await post(`/v1/portfolio/holdings/${stock.holding.id}/contributions`, {
      date: "2024-01-05", amount: 250000, kind: "actual", units: 100,
    });
    // fund holding (should be skipped by stooq refresh)
    await post("/v1/portfolio/holdings", { kind: "fund", name: "投信A" });

    const refresh = await (await post("/v1/portfolio/valuations/refresh")).json() as {
      summary: { succeeded: number; skipped: number };
    };
    expect(refresh.summary.succeeded).toBe(1);
    expect(refresh.summary.skipped).toBeGreaterThanOrEqual(1);

    // 100 株 × 終値 3000 = 300000
    const detail = await (await app.request(`/v1/portfolio/holdings/${stock.holding.id}`)).json() as {
      ret: { market_value: number };
    };
    expect(detail.ret.market_value).toBe(300000);
  });

  it("suggests dividend candidates (public-info only) via the dividend client", async () => {
    const res = await (await post("/v1/portfolio/dividends/suggest", { tickers: ["7203"] })).json() as {
      summary: { succeeded: number };
    };
    expect(res.summary.succeeded).toBe(1);

    const list = await (await app.request("/v1/portfolio/dividends/candidates")).json() as {
      items: { ticker: string; dividend_yield_pct: number; consecutive_increase_years: number }[];
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.ticker).toBe("7203");
    expect(list.items[0]!.dividend_yield_pct).toBe(2.5);
    expect(list.items[0]!.consecutive_increase_years).toBe(5);
  });

  it("projects portfolio-wide future value across scenarios", async () => {
    const h = await (await post("/v1/portfolio/holdings", {
      kind: "fund", name: "投信B", monthly_contribution: 30000,
    })).json() as { holding: { id: string } };
    await post(`/v1/portfolio/holdings/${h.holding.id}/valuations`, { as_of: "2024-03-01", market_value: 500000 });

    const proj = await (await app.request("/v1/portfolio/projection?years=20")).json() as {
      months: number;
      terminal: { conservative: number; base: number; optimistic: number };
    };
    expect(proj.months).toBe(240);
    expect(proj.terminal.optimistic).toBeGreaterThan(proj.terminal.base);
    expect(proj.terminal.base).toBeGreaterThan(proj.terminal.conservative);
  });

  it("summary aggregates holdings and totals", async () => {
    const h = await (await post("/v1/portfolio/holdings", {
      kind: "fund", name: "投信C", monthly_contribution: 10000, started_at: "2024-01-01",
    })).json() as { holding: { id: string } };
    await post(`/v1/portfolio/holdings/${h.holding.id}/contributions`, { date: "2024-01-05", amount: 10000, kind: "actual" });
    await post(`/v1/portfolio/holdings/${h.holding.id}/valuations`, { as_of: "2024-02-01", market_value: 11000 });

    const summary = await (await app.request("/v1/portfolio/summary?as_of=2024-02-01")).json() as {
      holdings: unknown[];
      totals: { invested: number; market_value: number; unrealized_pl: number };
    };
    expect(summary.holdings).toHaveLength(1);
    expect(summary.totals.invested).toBe(10000);
    expect(summary.totals.market_value).toBe(11000);
    expect(summary.totals.unrealized_pl).toBe(1000);
  });

  it("deletes a holding and cascades its sub-records", async () => {
    const h = await (await post("/v1/portfolio/holdings", { kind: "other", name: "tmp" })).json() as { holding: { id: string } };
    await post(`/v1/portfolio/holdings/${h.holding.id}/contributions`, { date: "2024-01-05", amount: 1000 });
    const del = await app.request(`/v1/portfolio/holdings/${h.holding.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const rows = db.prepare("SELECT COUNT(*) n FROM contributions WHERE holding_id = ?").get(h.holding.id) as { n: number };
    expect(rows.n).toBe(0);
  });
});
