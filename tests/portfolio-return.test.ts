import { describe, it, expect } from "vitest";
import {
  xirr,
  monthsBetween,
  computeHoldingReturn,
  type CashContribution,
} from "../src/services/portfolio-return.js";

describe("xirr", () => {
  it("-1000 → +1100 over exactly 1 year = 10%", () => {
    const r = xirr([
      { date: "2023-01-01", amount: -1000 },
      { date: "2024-01-01", amount: 1100 },
    ]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.1, 3);
  });

  it("periodic 積立 then terminal value yields a positive annualized rate", () => {
    const r = xirr([
      { date: "2023-01-01", amount: -100000 },
      { date: "2023-07-01", amount: -100000 },
      { date: "2024-01-01", amount: 220000 },
    ]);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0);
  });

  it("returns null when all cashflows share a sign", () => {
    expect(xirr([
      { date: "2023-01-01", amount: -100 },
      { date: "2024-01-01", amount: -100 },
    ])).toBeNull();
  });

  it("returns null with fewer than 2 flows", () => {
    expect(xirr([{ date: "2023-01-01", amount: -100 }])).toBeNull();
  });
});

describe("monthsBetween", () => {
  it("counts whole months", () => {
    expect(monthsBetween("2024-01-01", "2024-03-01")).toBe(2);
    expect(monthsBetween("2024-01-01", "2025-01-01")).toBe(12);
  });
  it("does not count a partial month", () => {
    expect(monthsBetween("2024-01-15", "2024-03-01")).toBe(1);
  });
});

describe("computeHoldingReturn", () => {
  const contributions: CashContribution[] = [
    { date: "2024-01-01", amount: 100000, kind: "actual" },
    { date: "2024-02-01", amount: 100000, kind: "actual" },
  ];

  it("computes invested / unrealized / simple return", () => {
    const r = computeHoldingReturn({
      contributions,
      dividends: [],
      marketValue: 220000,
      valuationAsOf: "2024-03-01",
      asOf: "2024-03-01",
      monthlyContribution: 100000,
      startedAt: "2024-01-01",
    });
    expect(r.invested).toBe(200000);
    expect(r.unrealized_pl).toBe(20000);
    expect(r.simple_return_pct).toBe(10);
    expect(r.annualized_xirr_pct).not.toBeNull();
    expect(r.annualized_xirr_pct!).toBeGreaterThan(0);
  });

  it("does not treat market value as gain when cost basis is unknown (invested=0)", () => {
    const r = computeHoldingReturn({
      contributions: [], // 取得原価 未入力 (株だけ登録)
      dividends: [],
      marketValue: 545400, // 評価額のみ判明
      valuationAsOf: "2026-06-17",
      asOf: "2026-06-18",
    });
    expect(r.invested).toBe(0);
    expect(r.market_value).toBe(545400);
    expect(r.unrealized_pl).toBeNull(); // 全額を利益にしない
    expect(r.simple_return_pct).toBeNull();
    expect(r.annualized_xirr_pct).toBeNull();
  });

  it("adds non-reinvested dividends to total return", () => {
    const r = computeHoldingReturn({
      contributions,
      dividends: [
        { pay_date: "2024-02-15", amount: 5000, reinvested: false },
        { pay_date: "2024-02-20", amount: 3000, reinvested: true }, // 評価額に内包 → 除外
      ],
      marketValue: 220000,
      valuationAsOf: "2024-03-01",
      asOf: "2024-03-01",
    });
    expect(r.dividends_received).toBe(5000);
    expect(r.total_return).toBe(25000); // 20000 含み益 + 5000 配当
  });

  it("plan-variance from monthly_contribution schedule (start month inclusive)", () => {
    const r = computeHoldingReturn({
      contributions: [{ date: "2024-01-01", amount: 100000, kind: "actual" }], // 1 回しか積めていない
      dividends: [],
      marketValue: null,
      valuationAsOf: null,
      asOf: "2024-03-01",
      monthlyContribution: 100000,
      startedAt: "2024-01-01",
    });
    expect(r.planned_to_date).toBe(300000); // 1/1・2/1・3/1 の 3 回が計画 (起算月込み)
    expect(r.actual_to_date).toBe(100000);
    expect(r.variance).toBe(-200000); // 計画より 20 万円 不足
  });

  it("on-plan monthly 積立 shows zero variance (start month counted)", () => {
    // 2025-12 開始・月3万を毎月実行 → 2026-06-18 時点で計画通り (差異 0)
    const months = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
    const r = computeHoldingReturn({
      contributions: months.map((m) => ({ date: `${m}-01`, amount: 30000, kind: "actual" as const })),
      dividends: [],
      marketValue: null,
      valuationAsOf: null,
      asOf: "2026-06-18",
      monthlyContribution: 30000,
      startedAt: "2025-12-01",
    });
    expect(r.actual_to_date).toBe(210000);
    expect(r.planned_to_date).toBe(210000);
    expect(r.variance).toBe(0);
  });

  it("plan-variance prefers explicit planned rows over schedule", () => {
    const r = computeHoldingReturn({
      contributions: [
        { date: "2024-01-01", amount: 50000, kind: "planned" },
        { date: "2024-02-01", amount: 50000, kind: "planned" },
        { date: "2024-01-01", amount: 50000, kind: "actual" },
      ],
      dividends: [],
      marketValue: null,
      valuationAsOf: null,
      asOf: "2024-02-15",
      monthlyContribution: 999999, // 無視されるべき
      startedAt: "2024-01-01",
    });
    expect(r.planned_to_date).toBe(100000);
    expect(r.actual_to_date).toBe(50000);
  });
});
