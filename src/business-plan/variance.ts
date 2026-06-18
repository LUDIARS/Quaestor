/**
 * 計画 vs 実績の差異分析 (純関数)。
 *
 * 事業計画の各年度 (Y1..) を fiscal_start 起点のカレンダー窓に割り当て、
 * その窓が経過 (or 進行中) なら実績 (売上=invoices, 経費=transactions出金) と突合する。
 * 実績の集計 (DB アクセス) は business-plan-service.ts が担い、 本 module は純計算のみ。
 */

import type { YearPnl } from "./quant.js";

export interface PlanWindow {
  period: string;     // "Y1"..
  from: string;       // ISO yyyy-mm-dd (含む)
  to: string;         // ISO yyyy-mm-dd (含む、 窓の最終日)
}

export interface PeriodActuals {
  sales: number;
  expenses: number;
}

export interface VarianceRow {
  period: string;
  window: PlanWindow;
  /** 窓の開始が today 以前 = 実績比較の対象 */
  elapsed: boolean;
  plannedSales: number;
  actualSales: number;
  salesVariance: number;          // 実績 - 計画
  salesAchievedPct: number | null; // 実績 / 計画 (%)
  plannedExpenses: number;        // 計画の原価+販管費
  actualExpenses: number;
  expenseVariance: number;
  plannedProfit: number;          // 計画営業利益
  actualProfit: number;           // 実績 (売上 - 経費)
}

export interface VarianceResult {
  available: boolean;             // fiscal_start 未設定なら false
  rows: VarianceRow[];
  reason?: string;
}

/** "yyyy-mm" から各年度のカレンダー窓を生成する */
export function planWindows(fiscalStart: string, horizon: number): PlanWindow[] {
  const m = /^(\d{4})-(\d{2})$/.exec(fiscalStart);
  if (!m) return [];
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10); // 1-based
  const windows: PlanWindow[] = [];
  for (let i = 0; i < horizon; i++) {
    const fromY = year + i;
    const from = `${pad4(fromY)}-${pad2(month)}-01`;
    // 窓の最終日 = 12ヶ月後の前日
    const endExclusive = addMonths(fromY, month, 12);
    const endDay = addDays(endExclusive.year, endExclusive.month, 1, -1);
    const to = `${pad4(endDay.year)}-${pad2(endDay.month)}-${pad2(endDay.day)}`;
    windows.push({ period: `Y${i + 1}`, from, to });
  }
  return windows;
}

/** pnl (計画) と実績を突合して差異行を作る。 today は ISO yyyy-mm-dd */
export function buildVariance(
  pnl: YearPnl[],
  windows: PlanWindow[],
  actualsByPeriod: Record<string, PeriodActuals>,
  today: string,
): VarianceRow[] {
  return windows.map((w) => {
    const p = pnl.find((x) => x.period === w.period);
    const plannedSales = p?.sales ?? 0;
    const plannedExpenses = (p?.cogs ?? 0) + (p?.sga ?? 0);
    const plannedProfit = p?.operatingProfit ?? plannedSales - plannedExpenses;
    const act = actualsByPeriod[w.period] ?? { sales: 0, expenses: 0 };
    return {
      period: w.period,
      window: w,
      elapsed: w.from <= today,
      plannedSales,
      actualSales: act.sales,
      salesVariance: act.sales - plannedSales,
      salesAchievedPct: plannedSales > 0 ? (act.sales / plannedSales) * 100 : null,
      plannedExpenses,
      actualExpenses: act.expenses,
      expenseVariance: act.expenses - plannedExpenses,
      plannedProfit,
      actualProfit: act.sales - act.expenses,
    };
  });
}

// ── 日付ユーティリティ (Date 非依存・純算術) ──

function pad2(n: number): string { return n.toString().padStart(2, "0"); }
function pad4(n: number): string { return n.toString().padStart(4, "0"); }

function addMonths(year: number, month1: number, delta: number): { year: number; month: number } {
  const zero = (year * 12 + (month1 - 1)) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month1 - 1]!;
}

/** (year, month1, day) に deltaDays を足す (本用途では -1 のみ) */
function addDays(year: number, month1: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  let d = day + deltaDays;
  let y = year;
  let m = month1;
  while (d < 1) {
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
    d += daysInMonth(y, m);
  }
  while (d > daysInMonth(y, m)) {
    d -= daysInMonth(y, m);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return { year: y, month: m, day: d };
}
