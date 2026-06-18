import { describe, it, expect } from "vitest";
import { runQuant, type QuantFigure } from "../src/business-plan/quant.js";

function fig(category: string, label: string, period: string, amount: number | null, tag?: string): QuantFigure {
  return { category, label, period, amount, tag: tag ?? null };
}

describe("runQuant — P&L と損益分岐", () => {
  it("年次 P&L と営業利益率を計算する", () => {
    const figs = [
      fig("sales", "売上高", "Y1", 10_000_000),
      fig("cogs", "原価", "Y1", 4_000_000),
      fig("sga", "販管費", "Y1", 3_000_000),
      fig("sales", "売上高", "Y2", 15_000_000),
      fig("cogs", "原価", "Y2", 6_000_000),
      fig("sga", "販管費", "Y2", 4_000_000),
    ];
    const { metrics } = runQuant(figs);
    expect(metrics.pnl).toHaveLength(2);
    expect(metrics.pnl[0]!.grossProfit).toBe(6_000_000);
    expect(metrics.pnl[0]!.operatingProfit).toBe(3_000_000);
    expect(metrics.pnl[0]!.operatingMargin).toBeCloseTo(0.3, 5);
  });

  it("損益分岐点 = 固定費 / (1 - 変動費率)", () => {
    const figs = [
      fig("sales", "売上高", "Y1", 10_000_000),
      fig("cogs", "原価", "Y1", 4_000_000), // 変動費率 0.4
      fig("sga", "販管費", "Y1", 3_000_000), // 固定費扱い
    ];
    const { metrics } = runQuant(figs);
    // 3,000,000 / (1 - 0.4) = 5,000,000
    expect(metrics.breakEven?.breakEvenSales).toBe(5_000_000);
    expect(metrics.breakEven?.marginOfSafety).toBeCloseTo(0.5, 5);
  });

  it("限界利益マイナス (原価>売上) は error", () => {
    const figs = [
      fig("sales", "売上高", "Y1", 1_000_000),
      fig("cogs", "原価", "Y1", 1_200_000),
      fig("sga", "販管費", "Y1", 100_000),
    ];
    const { findings } = runQuant(figs);
    expect(findings.some((f) => f.code === "negative_margin" && f.severity === "error")).toBe(true);
  });
});

describe("runQuant — 資金調達バランス / 自己資金比率", () => {
  it("調達と使途が一致しないと error", () => {
    const figs = [
      fig("use_of_funds", "設備資金", "base", 3_000_000),
      fig("use_of_funds", "運転資金", "base", 2_000_000),
      fig("funding", "自己資金", "base", 1_000_000, "own_funds"),
      fig("funding", "借入金", "base", 3_000_000),
    ];
    const { metrics, findings } = runQuant(figs);
    expect(metrics.funding?.totalUseOfFunds).toBe(5_000_000);
    expect(metrics.funding?.totalFunding).toBe(4_000_000);
    expect(metrics.funding?.balanced).toBe(false);
    expect(findings.some((f) => f.code === "funding_unbalanced")).toBe(true);
  });

  it("自己資金比率 < 1/10 は warning", () => {
    const figs = [
      fig("use_of_funds", "設備資金", "base", 10_000_000),
      fig("funding", "自己資金", "base", 500_000, "own_funds"), // 5%
      fig("funding", "借入金", "base", 9_500_000),
    ];
    const { metrics, findings } = runQuant(figs);
    expect(metrics.funding?.ownFundsRatio).toBeCloseTo(0.05, 5);
    expect(findings.some((f) => f.code === "low_own_funds")).toBe(true);
  });
});

describe("runQuant — 資金繰りショート検知", () => {
  it("累積残高がマイナスに落ちた最初の月を報告する", () => {
    const figs = [
      fig("cashflow", "期首残高", "base", 1_000_000),
      fig("cashflow", "月次純増減", "M1", -400_000),
      fig("cashflow", "月次純増減", "M2", -400_000),
      fig("cashflow", "月次純増減", "M3", -400_000), // ここで 1,000,000-1,200,000 = -200,000
    ];
    const { metrics, findings } = runQuant(figs);
    expect(metrics.cashflow?.shortageMonth).toBe(3);
    expect(metrics.cashflow?.minBalance).toBe(-200_000);
    expect(findings.some((f) => f.code === "cash_shortage" && f.severity === "error")).toBe(true);
  });

  it("ショートしなければ findings に cash_shortage は出ない", () => {
    const figs = [
      fig("cashflow", "期首残高", "base", 2_000_000),
      fig("cashflow", "月次純増減", "M1", -100_000),
      fig("cashflow", "月次純増減", "M2", 300_000),
    ];
    const { metrics, findings } = runQuant(figs);
    expect(metrics.cashflow?.shortageMonth).toBeNull();
    expect(findings.some((f) => f.code === "cash_shortage")).toBe(false);
  });
});

describe("runQuant — 付加価値額 +3% / 返済余力 / スコア", () => {
  it("付加価値額の年率成長が +3% 未満は warning", () => {
    const figs = [
      fig("value_added", "付加価値額", "Y1", 10_000_000),
      fig("value_added", "付加価値額", "Y2", 10_100_000), // +1%
    ];
    const { metrics, findings } = runQuant(figs);
    expect(metrics.valueAdded?.meetsThreeP).toBe(false);
    expect(findings.some((f) => f.code === "value_added_below_3p")).toBe(true);
  });

  it("返済余力不足 (営業利益 < 年間返済) は warning", () => {
    const figs = [
      fig("sales", "売上高", "Y1", 5_000_000),
      fig("cogs", "原価", "Y1", 2_000_000),
      fig("sga", "販管費", "Y1", 2_500_000), // 営業利益 500,000
      fig("repayment", "年間返済額", "Y1", 1_200_000),
    ];
    const { metrics, findings } = runQuant(figs);
    expect(metrics.repayment?.coverage).toBeLessThan(1);
    expect(findings.some((f) => f.code === "weak_repayment")).toBe(true);
  });

  it("健全な計画は高スコア・error なし", () => {
    const figs = [
      fig("sales", "売上高", "Y1", 12_000_000),
      fig("cogs", "原価", "Y1", 4_000_000),
      fig("sga", "販管費", "Y1", 5_000_000), // 営業利益 3,000,000
      fig("use_of_funds", "設備資金", "base", 3_000_000),
      fig("funding", "自己資金", "base", 1_500_000, "own_funds"),
      fig("funding", "借入金", "base", 1_500_000),
      fig("repayment", "年間返済額", "Y1", 600_000),
    ];
    const { score, findings } = runQuant(figs);
    expect(findings.some((f) => f.severity === "error")).toBe(false);
    expect(score).toBeGreaterThanOrEqual(90);
  });
});
