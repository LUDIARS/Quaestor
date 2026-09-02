/**
 * 月別集計 (エクセル簿記「ⅱ 各勘定科目の月別・摘要別 集計一覧」と「② 月別売上」互換)。
 *
 * 科目ごとの月別純額: 資産・費用は 借方 − 貸方、 収益・負債は 貸方 − 借方。
 * ② の月別売上は SUMIFS(仕訳帳!I, 仕訳帳!G, 1, MONTH(仕訳帳!B), m) = 売上科目の貸方合計。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-003 (spec/feature/household-bookkeeping.md)
 */

import type { AccountKind } from "../../db/seed.js";
import { balanceSign } from "./general-ledger.js";

export interface MonthlySourceLine {
  entry_date: string;
  debit_code: number;
  debit_amount: number;
  credit_code: number;
  credit_amount: number;
  description: string;
}

export interface MonthlyAccountSummary {
  code: number;
  name: string;
  kind: AccountKind;
  /** index 0 = 1 月 … 11 = 12 月 */
  months: number[];
  total: number;
  /** 摘要別 (年間合計、 降順) */
  by_description: { description: string; months: number[]; total: number }[];
}

export interface MonthlySummary {
  accounts: MonthlyAccountSummary[];
  /** ② 相当: 売上科目の月別貸方合計 */
  monthly_sales: number[];
  sales_total: number;
}

export const SALES_CODE = 1;

function monthIndex(isoDate: string): number | null {
  const m = Number(isoDate.slice(5, 7));
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m - 1 : null;
}

export function summarizeMonthly(
  lines: MonthlySourceLine[],
  accounts: { code: number; name: string; kind: AccountKind }[],
): MonthlySummary {
  const byCode = new Map<number, { months: number[]; desc: Map<string, number[]> }>();
  const ensure = (code: number) => {
    let e = byCode.get(code);
    if (!e) { e = { months: new Array<number>(12).fill(0), desc: new Map() }; byCode.set(code, e); }
    return e;
  };
  const kindOf = new Map(accounts.map((a) => [a.code, a.kind] as const));
  const monthlySales = new Array<number>(12).fill(0);

  for (const l of lines) {
    const mi = monthIndex(l.entry_date);
    if (mi === null) continue;
    const apply = (code: number, amount: number, side: 1 | -1) => {
      const kind = kindOf.get(code);
      if (!kind) return;
      const v = amount * side * balanceSign(kind);
      const e = ensure(code);
      e.months[mi] = (e.months[mi] ?? 0) + v;
      let d = e.desc.get(l.description);
      if (!d) { d = new Array<number>(12).fill(0); e.desc.set(l.description, d); }
      d[mi] = (d[mi] ?? 0) + v;
    };
    apply(l.debit_code, l.debit_amount, 1);
    apply(l.credit_code, l.credit_amount, -1);
    if (l.credit_code === SALES_CODE) monthlySales[mi] = (monthlySales[mi] ?? 0) + l.credit_amount;
  }

  const out: MonthlyAccountSummary[] = [];
  for (const a of [...accounts].sort((x, y) => x.code - y.code)) {
    const e = byCode.get(a.code);
    if (!e) continue;
    const total = e.months.reduce((s, v) => s + v, 0);
    const byDesc = [...e.desc.entries()]
      .map(([description, months]) => ({ description, months, total: months.reduce((s, v) => s + v, 0) }))
      .sort((x, y) => Math.abs(y.total) - Math.abs(x.total) || x.description.localeCompare(y.description));
    out.push({ code: a.code, name: a.name, kind: a.kind, months: e.months, total, by_description: byDesc });
  }

  return { accounts: out, monthly_sales: monthlySales, sales_total: monthlySales.reduce((s, v) => s + v, 0) };
}
