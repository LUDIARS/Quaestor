/**
 * 家計分析の期間定義 (純関数)。
 *
 * | window  | 範囲                              | 比較対象         |
 * | week    | anchor を含む月曜〜日曜             | 直前 7 日        |
 * | month   | anchor の月                        | 前月             |
 * | quarter | anchor 月を末尾とする 3 ヶ月        | その前 3 ヶ月     |
 * | half    | 同 6 ヶ月                          | その前 6 ヶ月     |
 * | year    | 同 12 ヶ月                         | その前 12 ヶ月    |
 *
 * 日付はすべて ISO yyyy-mm-dd、 UTC で計算する (時刻を持たないため TZ 依存なし)。
 *
 * @implements SPEC-HOUSEHOLD-ANALYSIS-002 (spec/feature/household-bookkeeping.md)
 */

import { isIsoDate } from "../../shared/text.js";

export type AnalysisWindow = "week" | "month" | "quarter" | "half" | "year";

export const ANALYSIS_WINDOWS: AnalysisWindow[] = ["week", "month", "quarter", "half", "year"];

export interface DateRange {
  from: string;
  to: string;
}

export interface ResolvedWindow {
  window: AnalysisWindow;
  anchor: string;
  current: DateRange;
  previous: DateRange;
  /** 表示ラベル (例 "2026-09", "2026-07〜2026-09") */
  label: string;
}

const WINDOW_MONTHS: Record<Exclude<AnalysisWindow, "week">, number> = {
  month: 1, quarter: 3, half: 6, year: 12,
};

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIso(iso: string): Date {
  if (!isIsoDate(iso)) throw new Error(`invalid date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  return d;
}

function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** yyyy-mm の月初 / 月末 */
function monthBounds(year: number, month0: number): DateRange {
  const from = new Date(Date.UTC(year, month0, 1));
  const to = new Date(Date.UTC(year, month0 + 1, 0));
  return { from: toIso(from), to: toIso(to) };
}

/** anchor 月を末尾とする n ヶ月の範囲 */
function trailingMonths(anchor: Date, n: number): DateRange {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const start = monthBounds(y, m - (n - 1));
  const end = monthBounds(y, m);
  return { from: start.from, to: end.to };
}

function weekBounds(anchor: Date): DateRange {
  // 月曜起点: getUTCDay() は 日=0 … 土=6
  const dow = anchor.getUTCDay();
  const offsetToMonday = (dow + 6) % 7;
  const from = addDays(toIso(anchor), -offsetToMonday);
  return { from, to: addDays(from, 6) };
}

export function resolveWindow(window: AnalysisWindow, anchorIso: string): ResolvedWindow {
  const anchor = parseIso(anchorIso);
  if (window === "week") {
    const current = weekBounds(anchor);
    const previous = { from: addDays(current.from, -7), to: addDays(current.from, -1) };
    return { window, anchor: anchorIso, current, previous, label: `${current.from}〜${current.to}` };
  }
  const n = WINDOW_MONTHS[window];
  const current = trailingMonths(anchor, n);
  const prevAnchor = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - n, 1));
  const previous = trailingMonths(prevAnchor, n);
  const label = n === 1 ? current.from.slice(0, 7) : `${current.from.slice(0, 7)}〜${current.to.slice(0, 7)}`;
  return { window, anchor: anchorIso, current, previous, label };
}

/** 範囲内の日付を列挙 (日別推移の軸)。 */
export function enumerateDays(range: DateRange): string[] {
  const out: string[] = [];
  let cur = range.from;
  while (cur <= range.to) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}
