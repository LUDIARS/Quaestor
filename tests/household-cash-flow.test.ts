import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { resolveWindow } from "../src/services/household/analysis-windows.js";
import { analyzeCashFlow } from "../src/services/household/household-cash-flow.js";
import { collectIncomeEvents } from "../src/services/household/income-events.js";

function sample() {
  return {
    window: resolveWindow("month", "2026-02-15"), asOf: "2026-03-01",
    coverage: { months: ["2026-01", "2026-02"] },
    income: [{ date: "2026-01-05", amount: 100000 }, { date: "2026-02-05", amount: 100000 }],
    spending: [{ date: "2026-01-10", household: 60000, business: 30000 },
      { date: "2026-02-10", household: 50000, business: 20000 }],
  };
}

describe("household cash flow", () => {
  it("deducts business spending before computing the savings proxy", () => {
    const result = analyzeCashFlow(sample());
    expect(result.current).toMatchObject({ income: 100000, outflow: 70000, balance: 30000, savings_rate: 0.3 });
    expect(result.trend).toBe("improving");
    expect(result.savings_rate_delta).toBeCloseTo(0.2);
    expect(result.monthly.map((month) => month.balance)).toEqual([10000, 30000]);
  });
  it("keeps a deficit negative and missing income unknown", () => {
    const input = sample();
    input.income[1]!.amount = 10000;
    expect(analyzeCashFlow(input).current.savings_rate).toBe(-6);
    input.income = input.income.slice(0, 1);
    const result = analyzeCashFlow(input);
    expect(result.current.savings_rate).toBeNull();
    expect(result.trend).toBe("insufficient_data");
  });
  it("does not treat missing spending or an unfinished period as savings", () => {
    const input = sample();
    input.spending = input.spending.slice(0, 1);
    input.asOf = "2026-02-15";
    expect(analyzeCashFlow(input)).toMatchObject({ trend: "insufficient_data", savings_rate_delta: null });
  });
  it("marks monthly rows clipped by weekly windows", () => {
    const input = sample();
    input.window = resolveWindow("week", "2026-02-02");
    expect(analyzeCashFlow(input).monthly.every((month) => month.is_partial)).toBe(true);
  });
  it("excludes transfers, nonpositive inflows and dates outside the selected range", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE transactions (id TEXT, date TEXT, amount_in INTEGER, is_transfer INTEGER);
        INSERT INTO transactions VALUES ('a','2026-02-01',100000,0), ('b','2026-02-02',500000,1),
        ('c','2026-01-01',10000,0), ('d','2026-02-03',0,0);`);
      expect(collectIncomeEvents(db, { from: "2026-02-01", to: "2026-02-28" }))
        .toEqual([{ date: "2026-02-01", amount: 100000 }]);
    } finally { db.close(); }
  });
});
