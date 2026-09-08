/** 家計分析のインカム集計。 振替を除いた入金取引だけを 1 イベントにする。
 * @implements SPEC-HOUSEHOLD-ANALYSIS-004 (spec/feature/household-bookkeeping.md) */
import type Database from "better-sqlite3";
import type { DateRange } from "./analysis-windows.js";

export interface IncomeEvent { date: string; amount: number }

/** Recorded inflows only; transfer flags are authoritative, journals are not added again. */
export function collectIncomeEvents(db: Database.Database, range: DateRange): IncomeEvent[] {
  return db.prepare(`SELECT date, amount_in AS amount FROM transactions
    WHERE is_transfer = 0 AND amount_in > 0 AND date >= ? AND date <= ?
    ORDER BY date, id`).all(range.from, range.to) as IncomeEvent[];
}
