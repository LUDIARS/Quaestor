/** Cash surplus is a savings proxy, not the change in an account balance.
 * @implements SPEC-HOUSEHOLD-ANALYSIS-004 (spec/feature/household-bookkeeping.md) */
import type { CashFlowPeriod, HouseholdCashFlow } from "../../shared/household-cash-flow.js";
import { enumerateDays, type ResolvedWindow } from "./analysis-windows.js";
import type { IncomeEvent } from "./income-events.js";

interface OutflowEvent { date: string; household: number; business: number }
interface CashFlowInput {
  window: ResolvedWindow;
  income: IncomeEvent[];
  spending: OutflowEvent[];
  coverage: { months: string[] };
  asOf: string;
}

function summarize(income: IncomeEvent[], spending: OutflowEvent[]): CashFlowPeriod {
  const inflow = income.reduce((sum, event) => sum + event.amount, 0);
  const household = spending.reduce((sum, event) => sum + event.household, 0);
  const business = spending.reduce((sum, event) => sum + event.business, 0);
  const outflow = household + business;
  const balance = inflow - outflow;
  return { income: inflow, household, business, outflow, balance,
    savings_rate: inflow > 0 ? balance / inflow : null, income_count: income.length };
}

export function analyzeCashFlow(input: CashFlowInput): HouseholdCashFlow {
  const period = (from: string, to: string): CashFlowPeriod => summarize(
    input.income.filter((event) => event.date >= from && event.date <= to),
    input.spending.filter((event) => event.date >= from && event.date <= to),
  );
  const current = period(input.window.current.from, input.window.current.to);
  const previous = period(input.window.previous.from, input.window.previous.to);
  const reasons: string[] = [];
  if (input.window.current.to >= input.asOf) reasons.push("対象期間がまだ終了していません。");
  if (current.income_count === 0) reasons.push("今期の入金記録がなく、貯蓄率を算出できません。");
  if (previous.income_count === 0) reasons.push("前期の入金記録がなく、貯蓄率を比較できません。");
  // previous と current が連続しない window でも、両期間の日だけを月別集計の母集合にする。
  const days = [...enumerateDays(input.window.previous), ...enumerateDays(input.window.current)];
  const months = [...new Set(days.map((day) => day.slice(0, 7)))].sort();
  const missing = months.filter((month) => !input.coverage.months.includes(month));
  if (missing.length > 0) reasons.push(`支出データのない月があります: ${missing.join("、")}`);
  // A week can share a coverage month with its comparison but still have no spending records.
  for (const [label, range] of [["今期", input.window.current], ["前期", input.window.previous]] as const) {
    if (!input.spending.some((event) => event.date >= range.from && event.date <= range.to)) {
      reasons.push(`${label}の支出記録がありません。`);
    }
  }
  const delta = reasons.length === 0 && current.savings_rate !== null && previous.savings_rate !== null
    ? current.savings_rate - previous.savings_rate : null;
  // Compare rates, so calendar periods with different lengths remain comparable.
  const trend = delta === null ? "insufficient_data" : delta > 0 ? "improving" : delta < 0 ? "declining" : "stable";
  const monthly = months.map((month) => {
    const monthDays = [...new Set(days.filter((day) => day.startsWith(month)))].sort();
    const from = monthDays[0]!;
    const to = monthDays[monthDays.length - 1]!;
    const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return { ...period(from, to), month, is_partial: from !== `${month}-01` || to !== end || end >= input.asOf };
  });
  return { current, previous, trend, reasons, savings_rate_delta: delta, monthly };
}
