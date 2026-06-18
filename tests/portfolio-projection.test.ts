import { describe, it, expect } from "vitest";
import { projectFuture, projectScenarios } from "../src/services/portfolio-projection.js";
import { aggregateTotals, type HoldingSummary } from "../src/services/portfolio-service.js";

describe("projectFuture", () => {
  it("0% return = pure accumulation of contributions", () => {
    const pts = projectFuture({ currentValue: 0, monthlyContribution: 10000, months: 12, annualReturnPct: 0 });
    expect(pts).toHaveLength(13); // month 0..12
    const last = pts[pts.length - 1]!;
    expect(last.contributed).toBe(120000);
    expect(last.value).toBe(120000);
  });

  it("positive return makes value exceed contributed principal", () => {
    const pts = projectFuture({ currentValue: 100000, monthlyContribution: 10000, months: 120, annualReturnPct: 5 });
    const last = pts[pts.length - 1]!;
    expect(last.value).toBeGreaterThan(last.contributed + 100000);
  });
});

describe("projectScenarios", () => {
  it("optimistic ≥ base ≥ conservative terminal value", () => {
    const s = projectScenarios({ currentValue: 100000, monthlyContribution: 30000, months: 240 });
    expect(s.terminal.optimistic).toBeGreaterThan(s.terminal.base);
    expect(s.terminal.base).toBeGreaterThan(s.terminal.conservative);
  });

  it("reports months to reach a target under the base scenario", () => {
    const s = projectScenarios({
      currentValue: 0,
      monthlyContribution: 10000,
      months: 240,
      rates: { conservative: 0, base: 0, optimistic: 0 },
      targetAmount: 120000,
    });
    // 0% で月1万 → 12 ヶ月で 12 万到達
    expect(s.base_months_to_target).toBe(12);
  });

  it("target unreachable within horizon → null", () => {
    const s = projectScenarios({
      currentValue: 0,
      monthlyContribution: 1000,
      months: 12,
      rates: { conservative: 0, base: 0, optimistic: 0 },
      targetAmount: 1_000_000,
    });
    expect(s.base_months_to_target).toBeNull();
  });
});

describe("aggregateTotals", () => {
  function mk(over: Partial<HoldingSummary["ret"]>, holding: Partial<HoldingSummary["holding"]> = {}): HoldingSummary {
    return {
      holding: {
        id: "x", kind: "fund", name: "f", account: null, ticker: null, fund_code: null,
        currency: "JPY", tax_wrapper: null, target_amount: null, monthly_contribution: null,
        status: "active", started_at: null, notes: null, metadata: null, created_at: 0, updated_at: 0,
        ...holding,
      },
      latest_valuation: null,
      ret: {
        invested: 0, market_value: null, dividends_received: 0, unrealized_pl: null,
        total_return: null, simple_return_pct: null, annualized_xirr_pct: null,
        planned_to_date: null, actual_to_date: 0, variance: null, variance_pct: null,
        ...over,
      },
    };
  }

  it("sums invested + market value and computes blended return", () => {
    const totals = aggregateTotals([
      mk({ invested: 100000, market_value: 120000, unrealized_pl: 20000, actual_to_date: 100000, planned_to_date: 100000 }, { monthly_contribution: 10000 }),
      mk({ invested: 50000, market_value: 55000, unrealized_pl: 5000, dividends_received: 1000, actual_to_date: 50000, planned_to_date: 60000 }, { monthly_contribution: 5000 }),
    ]);
    expect(totals.invested).toBe(150000);
    expect(totals.market_value).toBe(175000);
    expect(totals.unrealized_pl).toBe(25000);
    expect(totals.dividends_received).toBe(1000);
    expect(totals.monthly_contribution).toBe(15000);
    expect(totals.variance).toBe(-10000); // 150000 - 160000
    // blended return = (25000 + 1000) / 150000
    expect(totals.simple_return_pct).toBeCloseTo(17.33, 1);
  });

  it("excludes unvalued holdings from the return denominator", () => {
    const totals = aggregateTotals([
      mk({ invested: 100000, market_value: 110000, unrealized_pl: 10000 }),
      mk({ invested: 50000, market_value: null }), // 評価額未取得 → 分母から除外
    ]);
    expect(totals.invested).toBe(150000);
    expect(totals.valued_invested).toBe(100000);
    expect(totals.simple_return_pct).toBe(10); // 10000/100000
  });
});
