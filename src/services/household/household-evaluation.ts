/**
 * Evaluate recorded household spending against the preceding period.
 * @implements SPEC-HOUSEHOLD-ANALYSIS-003 (spec/feature/household-bookkeeping.md)
 */
import type { HouseholdEvaluation } from "../../shared/household-evaluation.js";
import { isIsoDate } from "../../shared/text.js";
import { enumerateDays, type ResolvedWindow } from "./analysis-windows.js";

const CHANGE_THRESHOLD = 0.1;
const MAX_DRIVERS = 5;

interface EvaluationInput {
  window: ResolvedWindow;
  coverage: { months: string[] };
  totals: {
    current: { household: number; count: number };
    previous: { household: number; count: number };
  };
  by_category: { category_id: number; name: string; current: number; previous: number }[];
}

export function evaluateHousehold(input: EvaluationInput, asOf: string): HouseholdEvaluation {
  if (!isIsoDate(asOf)) throw new Error("invalid evaluation date");
  const currentDays = enumerateDays(input.window.current);
  const previousDays = enumerateDays(input.window.previous);
  const currentDaily = input.totals.current.household / currentDays.length;
  const previousDaily = input.totals.previous.household / previousDays.length;
  const reasons: string[] = [];
  if (input.window.current.to >= asOf) reasons.push("対象期間がまだ終了していません。");
  if (input.totals.current.count === 0) reasons.push("今期の支出データがありません。");
  if (input.totals.previous.count === 0) reasons.push("前期の支出データがありません。");
  if (input.totals.previous.household === 0) reasons.push("前期の家計支出がゼロのため増減率を算出できません。");
  const recordedMonths = new Set(input.coverage.months);
  const missingMonths = [...new Set([...previousDays, ...currentDays].map((day) => day.slice(0, 7)))]
    .filter((month) => !recordedMonths.has(month));
  if (missingMonths.length > 0) reasons.push(`支出データのない月があります: ${missingMonths.join("、")}`);

  const changeRate = reasons.length === 0 ? (currentDaily - previousDaily) / previousDaily : null;
  const status = changeRate === null ? "insufficient_data"
    : changeRate >= CHANGE_THRESHOLD ? "increased"
      : changeRate <= -CHANGE_THRESHOLD ? "decreased" : "stable";
  // Category 0 is the analysis contract's business-only pseudo category.
  const drivers = changeRate === null ? [] : input.by_category
    .filter((category) => category.category_id !== 0)
    .map((category) => ({
      category_id: category.category_id,
      name: category.name,
      daily_delta: category.current / currentDays.length - category.previous / previousDays.length,
    }))
    .filter((category) => category.daily_delta !== 0)
    .sort((a, b) => Math.abs(b.daily_delta) - Math.abs(a.daily_delta) || a.category_id - b.category_id)
    .slice(0, MAX_DRIVERS);
  return {
    status, reasons, current_daily: currentDaily, previous_daily: previousDaily,
    change_rate: changeRate, threshold: CHANGE_THRESHOLD, drivers,
  };
}
