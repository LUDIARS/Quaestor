/**
 * 特殊仕訳 (クレカ明細から出ない手動仕訳) のテンプレート。 calc/特殊仕訳カテゴリ.md を写した。
 *
 * | template                 | 借方 / 貸方             | 備考 |
 * | sales_deposit            | 102 当座預金 / 1 売上   | 振込入金 |
 * | sales_with_withholding   | 102 / 1 と 117 仮払税金 / 1 | 源泉 10.21% を売上総額から逆算 |
 * | cash_withdrawal          | 101 現金 / 102          | ATM 引出 |
 * | interest                 | 102 / 172 事業主借      | 利息入金 |
 * | rent                     | 23 地代家賃 / 102       | 家賃振込 |
 * | resident_tax             | 124 事業主貸 / 102      | 住民税等 (家計) |
 * | household_bank           | 124 / 102               | 銀行からの家計引落 (家計) |
 * | cash_expense             | <code> / 101            | 現金経費 (Suica / 会議費 現金払い) |
 * | custom                   | <debit> / <credit>      | 任意 |
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-001 (spec/feature/household-bookkeeping.md)
 */

import type { CreateJournalEntryInput } from "../../db/journal-entries-repo.js";

export const MANUAL_TEMPLATES = [
  "sales_deposit", "sales_with_withholding", "cash_withdrawal", "interest", "rent",
  "resident_tax", "household_bank", "cash_expense", "custom",
] as const;
export type ManualTemplate = (typeof MANUAL_TEMPLATES)[number];

/** 源泉徴収税率 (所得税 10% + 復興特別所得税 0.21%) */
export const WITHHOLDING_RATE = 0.1021;

export const CODE = {
  SALES: 1, RENT: 23, CASH: 101, BANK: 102, PREPAID_TAX: 117, OWNER_DRAW: 124, OWNER_LOAN: 172,
} as const;

export interface ManualEntryInput {
  template: ManualTemplate;
  fiscal_year: number;
  entry_date: string;
  amount: number;
  description: string;
  /** cash_expense の経費科目 / custom の借方 */
  debit_code?: number;
  /** custom の貸方 */
  credit_code?: number;
  household_category_id?: number | null;
  receipt_id?: string | null;
}

function base(input: ManualEntryInput, debit: number, credit: number, amount: number, leg: CreateJournalEntryInput["leg"]): CreateJournalEntryInput {
  return {
    fiscal_year: input.fiscal_year,
    entry_date: input.entry_date,
    debit_code: debit,
    debit_amount: amount,
    credit_code: credit,
    credit_amount: amount,
    description: input.description,
    payment: input.amount,
    rate: leg === "household" ? 0 : 1,
    origin: "manual",
    leg,
    receipt_id: input.receipt_id ?? null,
    household_category_id: leg === "household" ? (input.household_category_id ?? null) : null,
    locked: true,
  };
}

/** 1 テンプレートから 1〜2 行の仕訳入力を作る。 入力不備は例外 (fail-fast)。 */
export function buildManualEntries(input: ManualEntryInput): CreateJournalEntryInput[] {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error("amount must be a positive integer");
  switch (input.template) {
    case "sales_deposit":
      return [base(input, CODE.BANK, CODE.SALES, input.amount, "income")];
    case "sales_with_withholding": {
      const tax = Math.floor(input.amount * WITHHOLDING_RATE);
      const net = input.amount - tax;
      return [
        base(input, CODE.BANK, CODE.SALES, net, "income"),
        { ...base(input, CODE.PREPAID_TAX, CODE.SALES, tax, "income"), description: `源泉所得税(${input.description})` },
      ];
    }
    case "cash_withdrawal":
      return [base(input, CODE.CASH, CODE.BANK, input.amount, null)];
    case "interest":
      return [base(input, CODE.BANK, CODE.OWNER_LOAN, input.amount, "income")];
    case "rent":
      return [base(input, CODE.RENT, CODE.BANK, input.amount, "expense")];
    case "resident_tax":
    case "household_bank":
      return [base(input, CODE.OWNER_DRAW, CODE.BANK, input.amount, "household")];
    case "cash_expense":
      if (!input.debit_code) throw new Error("cash_expense requires debit_code");
      return [base(input, input.debit_code, CODE.CASH, input.amount, "expense")];
    case "custom":
      if (!input.debit_code || !input.credit_code) throw new Error("custom requires debit_code and credit_code");
      return [base(input, input.debit_code, input.credit_code, input.amount,
        input.debit_code === CODE.OWNER_DRAW ? "household" : null)];
  }
}
