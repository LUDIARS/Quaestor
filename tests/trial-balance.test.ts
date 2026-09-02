import { describe, it, expect } from "vitest";
import { computeTrialBalance, type AccountInfo, type LedgerLine } from "../src/services/bookkeeping/trial-balance.js";
import { buildFinancialReport } from "../src/services/bookkeeping/financial-report.js";

const ACCOUNTS: AccountInfo[] = [
  { code: 1, name: "売上（収入）", kind: "revenue" },
  { code: 12, name: "通信費", kind: "expense" },
  { code: 26, name: "ソフトウエア購入費", kind: "expense" },
  { code: 101, name: "現金", kind: "asset" },
  { code: 102, name: "当座預金", kind: "asset" },
  { code: 117, name: "仮払税金", kind: "asset" },
  { code: 124, name: "事業主貸", kind: "asset" },
  { code: 172, name: "事業主借", kind: "liability" },
];

/** エクセル簿記の仕訳パターンをそのまま並べた固定セット */
const LINES: LedgerLine[] = [
  { debit_code: 102, debit_amount: 89_790, credit_code: 1, credit_amount: 89_790 },     // 売上入金 (源泉後)
  { debit_code: 117, debit_amount: 10_210, credit_code: 1, credit_amount: 10_210 },     // 源泉税
  { debit_code: 26, debit_amount: 14_679, credit_code: 102, credit_amount: 14_679 },    // NOTION 100%
  { debit_code: 12, debit_amount: 4_729, credit_code: 102, credit_amount: 4_729 },      // au 70%
  { debit_code: 124, debit_amount: 2_027, credit_code: 102, credit_amount: 2_027 },     // au 家計 30%
  { debit_code: 101, debit_amount: 30_000, credit_code: 102, credit_amount: 30_000 },   // 現金引出
  { debit_code: 102, debit_amount: 12, credit_code: 172, credit_amount: 12 },           // 利息
];

/** Excel の SUMIF(仕訳帳!D, code, F) / SUMIF(仕訳帳!G, code, I) を素朴に再計算 */
function sumif(lines: LedgerLine[], code: number): { debit: number; credit: number } {
  return {
    debit: lines.filter((l) => l.debit_code === code).reduce((s, l) => s + l.debit_amount, 0),
    credit: lines.filter((l) => l.credit_code === code).reduce((s, l) => s + l.credit_amount, 0),
  };
}

describe("trial balance (精算表)", () => {
  it("借方合計 / 貸方合計 は SUMIF と一致する", () => {
    const tb = computeTrialBalance(LINES, ACCOUNTS);
    for (const row of tb.rows) {
      const ref = sumif(LINES, row.code);
      expect(row.debit_total).toBe(ref.debit);
      expect(row.credit_total).toBe(ref.credit);
    }
    expect(tb.subtotal.debit_total).toBe(tb.subtotal.credit_total);
  });

  it("損益科目は PL 列、 資産・負債は BS 列に振り分ける", () => {
    const tb = computeTrialBalance(LINES, ACCOUNTS);
    const byCode = new Map(tb.rows.map((r) => [r.code, r]));
    expect(byCode.get(1)!.pl_credit).toBe(100_000);
    expect(byCode.get(1)!.bs_credit).toBe(0);
    expect(byCode.get(26)!.pl_debit).toBe(14_679);
    expect(byCode.get(102)!.bs_debit).toBe(89_790 - 14_679 - 4_729 - 2_027 - 30_000 + 12);
    expect(byCode.get(102)!.pl_debit).toBe(0);
    expect(byCode.get(172)!.bs_credit).toBe(12);
  });

  it("所得 = 収益 − 費用 で、 合計行は PL / BS ともに貸借一致する", () => {
    const tb = computeTrialBalance(LINES, ACCOUNTS);
    expect(tb.income).toBe(100_000 - 14_679 - 4_729);
    expect(tb.total.pl_debit).toBe(tb.total.pl_credit);
    expect(tb.total.bs_debit).toBe(tb.total.bs_credit);
  });

  it("期首残高は 期首 + 増減 = 期末 で BS 列に効く", () => {
    const opening = new Map([[102, { debit: 500_000, credit: 0 }], [172, { debit: 0, credit: 1_000 }]]);
    const tb = computeTrialBalance(LINES, ACCOUNTS, opening);
    const bank = tb.rows.find((r) => r.code === 102)!;
    expect(bank.bs_debit).toBe(500_000 + bank.debit_total - bank.credit_total);
    const loan = tb.rows.find((r) => r.code === 172)!;
    expect(loan.bs_credit).toBe(1_000 + 12);
    expect(tb.opening_equity).toBe(499_000);
    expect(tb.total.bs_debit).toBe(tb.total.bs_credit);
  });

  it("勘定科目に無いコードを警告として返す", () => {
    const tb = computeTrialBalance([{ debit_code: 999, debit_amount: 1, credit_code: 102, credit_amount: 1 }], ACCOUNTS);
    expect(tb.unknown_codes).toEqual([999]);
  });
});

describe("financial report (決算書)", () => {
  it("PL は 売上・科目別経費・所得、 BS は貸借一致", () => {
    const opening = new Map([[102, { debit: 500_000, credit: 0 }]]);
    const rep = buildFinancialReport(computeTrialBalance(LINES, ACCOUNTS, opening));
    expect(rep.pl.sales_total).toBe(100_000);
    expect(rep.pl.expenses.map((e) => e.code)).toEqual([12, 26]);
    expect(rep.pl.expense_total).toBe(14_679 + 4_729);
    expect(rep.pl.income).toBe(100_000 - 14_679 - 4_729);
    expect(rep.bs.assets_opening_total).toBe(500_000);
    expect(rep.bs.liabilities.find((line) => line.code === 0)).toEqual({
      code: 0, name: "元入金（期首差額）", opening: 500_000, closing: 500_000,
    });
    expect(rep.bs.liabilities.reduce((sum, line) => sum + line.opening, 0)).toBe(rep.bs.liabilities_opening_total);
    expect(rep.bs.balanced).toBe(true);
    expect(rep.bs.assets_closing_total).toBe(rep.bs.liabilities_closing_total + rep.bs.income);
  });
});
