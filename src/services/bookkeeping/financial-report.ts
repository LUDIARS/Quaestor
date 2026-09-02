/**
 * 決算書 (エクセル簿記「決算書①」= 損益計算書、「④」= 貸借対照表) を精算表から組む。
 *
 * PL: 売上 = 収益科目の貸方残高、 経費 = 費用科目の借方残高、 所得 = 売上 − 経費。
 * BS: 資産の期末 = 精算表 L 列、 負債・資本の期末 = 精算表 M 列、
 *     資本側に「青色申告特別控除前の所得金額」を足すと 資産合計 = 負債・資本合計 になる。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-003 (spec/feature/household-bookkeeping.md)
 */

import type { TrialBalance } from "./trial-balance.js";

export interface ReportLine {
  code: number;
  name: string;
  amount: number;
}

export interface BalanceLine {
  code: number;
  name: string;
  opening: number;
  closing: number;
}

export interface ProfitAndLoss {
  revenues: ReportLine[];
  sales_total: number;
  expenses: ReportLine[];
  expense_total: number;
  income: number;
}

export interface BalanceSheet {
  assets: BalanceLine[];
  liabilities: BalanceLine[];
  assets_opening_total: number;
  assets_closing_total: number;
  liabilities_opening_total: number;
  liabilities_closing_total: number;
  income: number;
  /** 資産期末合計 = 負債・資本期末合計 + 所得 が成り立つか */
  balanced: boolean;
}

export interface FinancialReport {
  pl: ProfitAndLoss;
  bs: BalanceSheet;
}

export function buildFinancialReport(tb: TrialBalance): FinancialReport {
  const revenues: ReportLine[] = [];
  const expenses: ReportLine[] = [];
  const assets: BalanceLine[] = [];
  const liabilities: BalanceLine[] = [];

  for (const r of tb.rows) {
    switch (r.kind) {
      case "revenue":
        if (r.pl_credit || r.pl_debit) revenues.push({ code: r.code, name: r.name, amount: r.pl_credit - r.pl_debit });
        break;
      case "expense":
        if (r.pl_credit || r.pl_debit) expenses.push({ code: r.code, name: r.name, amount: r.pl_debit - r.pl_credit });
        break;
      case "asset": {
        const opening = r.opening_debit - r.opening_credit;
        if (opening || r.bs_debit || r.debit_total || r.credit_total) {
          assets.push({ code: r.code, name: r.name, opening, closing: r.bs_debit });
        }
        break;
      }
      case "liability": {
        const opening = r.opening_credit - r.opening_debit;
        if (opening || r.bs_credit || r.debit_total || r.credit_total) {
          liabilities.push({ code: r.code, name: r.name, opening, closing: r.bs_credit });
        }
        break;
      }
    }
  }

  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  const salesTotal = sum(revenues.map((r) => r.amount));
  const expenseTotal = sum(expenses.map((r) => r.amount));
  const income = salesTotal - expenseTotal;

  const assetsOpening = sum(assets.map((a) => a.opening));
  const assetsClosing = sum(assets.map((a) => a.closing));
  // account_codes has no separate capital kind. Make the inferred opening
  // proprietor equity an explicit report line so displayed rows equal totals.
  if (tb.opening_equity) {
    liabilities.push({ code: 0, name: "元入金（期首差額）", opening: tb.opening_equity, closing: tb.opening_equity });
  }
  const liabOpening = sum(liabilities.map((a) => a.opening));
  const liabClosing = sum(liabilities.map((a) => a.closing));

  return {
    pl: { revenues, sales_total: salesTotal, expenses, expense_total: expenseTotal, income },
    bs: {
      assets, liabilities,
      assets_opening_total: assetsOpening,
      assets_closing_total: assetsClosing,
      liabilities_opening_total: liabOpening,
      liabilities_closing_total: liabClosing,
      income,
      balanced: assetsClosing === liabClosing + income,
    },
  };
}
