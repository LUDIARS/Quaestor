import { describe, expect, it } from "vitest";
import { resolveWindow } from "../src/services/household/analysis-windows.js";
import { evaluateHousehold } from "../src/services/household/household-evaluation.js";
import { suggestSavings } from "../src/services/household/saving-suggestions.js";

function sample() {
  return {
    window: resolveWindow("month", "2026-02-15"), coverage: { months: ["2026-01", "2026-02"] },
    totals: { current: { household: 28000, count: 5 }, previous: { household: 31000, count: 5 } },
    by_category: [{ category_id: 1, name: "食費(外食)", current: 28000, previous: 31000, count: 5 }],
  };
}

describe("household evaluation", () => {
  it("compares daily spending across unequal calendar months", () => {
    expect(evaluateHousehold(sample(), "2026-03-01")).toMatchObject({ status: "stable", change_rate: 0 });
  });
  it("includes both ten-percent boundaries", () => {
    for (const [amount, status] of [[30800, "increased"], [25200, "decreased"]] as const) {
      const input = sample();
      input.totals.current.household = amount;
      expect(evaluateHousehold(input, "2026-03-01").status).toBe(status);
    }
  });
  it("withholds the verdict for an unfinished period, missing months and zero baseline", () => {
    const input = sample();
    input.coverage.months = ["2026-02"];
    input.totals.previous.household = 0;
    const result = evaluateHousehold(input, "2026-02-28");
    expect(result.status).toBe("insufficient_data");
    expect(result.change_rate).toBeNull();
    expect(result.drivers).toEqual([]);
    expect(result.reasons).toHaveLength(3);
  });
  it("retains disappeared household categories but excludes business drivers", () => {
    const input = sample();
    input.by_category.push({ category_id: 0, name: "事業経費", current: 999999, previous: 0, count: 1 },
      { category_id: 2, name: "旅行・レジャー", current: 0, previous: 31000, count: 0 });
    expect(evaluateHousehold(input, "2026-03-01").drivers).toEqual([
      { category_id: 2, name: "旅行・レジャー", daily_delta: -1000 },
    ]);
  });
  it("suggests discretionary spending with a transparent scenario, never medical expenses", () => {
    const categories = sample().by_category;
    categories.push({ category_id: 3, name: "医療", current: 100000, previous: 0, count: 5 },
      { category_id: 4, name: "独自費目", current: 50000, previous: 0, count: 5 });
    expect(suggestSavings(categories)).toEqual([
      expect.objectContaining({ category_id: 1, amount: 28000, count: 5, scenario_saving: 2800, reduction_rate: 0.1 }),
    ]);
  });
});
