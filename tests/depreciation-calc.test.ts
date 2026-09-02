import { describe, it, expect } from "vitest";
import { depreciationForYear, monthsInYear, projectDepreciation, projectUntilDone, type DepreciableAsset } from "../src/services/depreciation/depreciation-calc.js";
import { resolveFamily, resolveRate, rateRow } from "../src/services/depreciation/rate-table.js";

const base = (over: Partial<DepreciableAsset>): DepreciableAsset => ({
  acquired_on: "2024-07-01", cost: 300_000, method: "straight_line", useful_life: 4, business_ratio: 1, ...over,
});

describe("rate table / family", () => {
  it("取得日で family が決まる", () => {
    expect(resolveFamily("straight_line", "2007-03-31")).toBe("old_sl");
    expect(resolveFamily("straight_line", "2007-04-01")).toBe("sl");
    expect(resolveFamily("declining_balance", "2007-04-01")).toBe("db250");
    expect(resolveFamily("declining_balance", "2012-04-01")).toBe("db200");
    expect(resolveFamily("old_declining_balance", "2000-01-01")).toBe("old_db");
    expect(resolveFamily("lump_sum_3y", "2024-01-01")).toBeNull();
  });

  it("償却率表は 2〜50 年、 Excel 由来の値を持つ", () => {
    expect(rateRow(1)).toBeNull();
    expect(rateRow(5)).toMatchObject({ old_sl: 0.2, old_db: 0.369, sl: 0.2, db250: 0.5, db250_revised: 1, db250_guarantee: 0.06249, db200: 0.4, db200_revised: 0.5, db200_guarantee: 0.108 });
    expect(rateRow(50)).toMatchObject({ sl: 0.02, db250: 0.05 });
    expect(resolveRate("db200", 4)).toEqual({ family: "db200", rate: 0.5, revised_rate: 1, guarantee_rate: 0.12499 });
  });
});

describe("monthsInYear", () => {
  it("取得年は取得月〜12 月、 除却年は 1 月〜除却月", () => {
    const a = base({ acquired_on: "2024-07-15", disposed_on: "2026-03-10" });
    expect(monthsInYear(a, 2023)).toBe(0);
    expect(monthsInYear(a, 2024)).toBe(6);
    expect(monthsInYear(a, 2025)).toBe(12);
    expect(monthsInYear(a, 2026)).toBe(3);
    expect(monthsInYear(a, 2027)).toBe(0);
  });
});

describe("定額 (新)", () => {
  it("月割で償却し、 最後は備忘価額 1 円を残す", () => {
    const rows = projectUntilDone(base({}));
    // 300,000 × 0.25 = 75,000/年。 2024 は 6 ヶ月 → 37,500
    expect(rows.map((r) => [r.year, r.total, r.closing_book])).toEqual([
      [2024, 37_500, 262_500], [2025, 75_000, 187_500], [2026, 75_000, 112_500], [2027, 75_000, 37_500], [2028, 37_499, 1],
    ]);
    expect(rows[0]!.basis).toBe(300_000);
    expect(rows[0]!.family).toBe("sl");
  });

  it("事業専用割合で経費算入額と家計分に割れる", () => {
    const y = depreciationForYear(base({ business_ratio: 0.7 }), 2025);
    expect(y.total).toBe(75_000);
    expect(y.expense).toBe(52_500);
    expect(y.household).toBe(22_500);
  });

  it("期首簿価と期首年を指定すると、 そこから計算する", () => {
    const y = depreciationForYear(base({ opening_year: 2026, opening_book_value: 100_000 }), 2026);
    expect(y.opening_book).toBe(100_000);
    expect(y.total).toBe(75_000);
    expect(y.closing_book).toBe(25_000);
  });
});

describe("定率 200%", () => {
  it("保証率を下回った年から改定償却率に切り替わる", () => {
    // 1,000,000 / 5 年 / 2020-01 取得: 率 0.4、 保証 0.108 → 108,000、 改定 0.5
    const rows = projectUntilDone(base({ acquired_on: "2020-01-01", cost: 1_000_000, method: "declining_balance", useful_life: 5 }));
    expect(rows.slice(0, 3).map((r) => [r.year, r.total, r.closing_book, r.revised])).toEqual([
      [2020, 400_000, 600_000, false], [2021, 240_000, 360_000, false], [2022, 144_000, 216_000, false],
    ]);
    // 2023: 216,000 × 0.4 = 86,400 < 108,000 → 改定取得価額 216,000 × 0.5 = 108,000
    expect(rows[3]).toMatchObject({ year: 2023, revised: true, basis: 216_000, rate: 0.5, total: 108_000, closing_book: 108_000, revised_cost: 216_000 });
    // 2024: 改定取得価額のまま 108,000 → 残り 1 円
    expect(rows[4]).toMatchObject({ year: 2024, revised: true, total: 107_999, closing_book: 1 });
    expect(rows).toHaveLength(5);
  });

  it("2007-04〜2012-03 取得は 250% の率を使う", () => {
    const y = depreciationForYear(base({ acquired_on: "2010-01-01", cost: 100_000, method: "declining_balance", useful_life: 5 }), 2010);
    expect(y.family).toBe("db250");
    expect(y.rate).toBe(0.5);
    expect(y.total).toBe(50_000);
  });
});

describe("旧定額 / 旧定率", () => {
  it("旧定額は取得価額 × 0.9 を基礎に 5% まで償却し、 その後 5 年均等", () => {
    // 100,000 / 5 年 / 2000-01: 基礎 90,000 × 0.2 = 18,000/年 → 5 年で簿価 10,000。 5% (5,000) まで 18,000 上限
    const rows = projectUntilDone(base({ acquired_on: "2000-01-01", cost: 100_000, method: "old_straight_line", useful_life: 5 }));
    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2000)).toMatchObject({ family: "old_sl", basis: 90_000, total: 18_000 });
    expect(byYear.get(2004)!.closing_book).toBe(10_000);
    expect(byYear.get(2005)).toMatchObject({ total: 5_000, closing_book: 5_000 });   // 5% 価額まで
    // 以降 (5,000 − 1) / 5 = 1,000 (切上げ) を 5 年
    expect(rows.filter((r) => r.year >= 2006).map((r) => r.total)).toEqual([1_000, 1_000, 1_000, 1_000, 999]);
    expect(rows[rows.length - 1]!.closing_book).toBe(1);
  });

  it("旧定率は期首簿価が基礎", () => {
    const y = depreciationForYear(base({ acquired_on: "2000-01-01", cost: 100_000, method: "old_declining_balance", useful_life: 5 }), 2001);
    expect(y.family).toBe("old_db");
    const first = depreciationForYear(base({ acquired_on: "2000-01-01", cost: 100_000, method: "old_declining_balance", useful_life: 5 }), 2000);
    expect(first.total).toBe(36_900);
    expect(y.basis).toBe(63_100);
    expect(y.total).toBe(Math.round(63_100 * 0.369));
  });
});

describe("一括 / 即時 / 除却", () => {
  it("一括償却は 3 年均等 (月割なし)、 最終年に残り全部", () => {
    const rows = projectUntilDone(base({ acquired_on: "2024-11-01", cost: 150_000, method: "lump_sum_3y" }));
    expect(rows.map((r) => r.total)).toEqual([50_000, 50_000, 50_000]);
    expect(rows[2]!.closing_book).toBe(0);
  });

  it("即時償却は取得年に全額", () => {
    const rows = projectUntilDone(base({ acquired_on: "2024-11-01", cost: 250_000, method: "immediate" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ total: 250_000, closing_book: 0 });
  });

  it("除却後は償却しない", () => {
    const rows = projectDepreciation(base({ disposed_on: "2025-03-31" }), 2026);
    expect(rows.map((r) => [r.year, r.months, r.total])).toEqual([[2024, 6, 37_500], [2025, 3, 18_750], [2026, 0, 0]]);
  });

  it("耐用年数が表に無ければ例外", () => {
    expect(() => depreciationForYear(base({ useful_life: 1 }), 2024)).toThrow(/rate not found/);
  });
});
