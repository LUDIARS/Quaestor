/**
 * 総勘定元帳 (エクセル簿記「元帳ⅰ」互換)。 科目を 1 つ選び、 仕訳帳からその科目が
 * 借方 / 貸方に出る行を日付順に並べ、 相手科目と残高の推移を付ける。
 *
 * 残高の向き: 資産・費用は 借方 − 貸方、 負債・資本・収益は 貸方 − 借方 (Excel の T 列「借方0貸方1」)。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-003 (spec/feature/household-bookkeeping.md)
 */

import type { AccountKind } from "../../db/seed.js";

export interface LedgerSourceLine {
  id: number;
  entry_date: string;
  no: number;
  debit_code: number;
  debit_amount: number;
  credit_code: number;
  credit_amount: number;
  description: string;
}

export interface GeneralLedgerLine {
  entry_id: number;
  entry_date: string;
  no: number;
  /** 相手科目 */
  counter_code: number;
  counter_name: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface GeneralLedger {
  code: number;
  name: string;
  kind: AccountKind;
  opening: number;
  lines: GeneralLedgerLine[];
  debit_total: number;
  credit_total: number;
  closing: number;
}

export function balanceSign(kind: AccountKind): 1 | -1 {
  return kind === "asset" || kind === "expense" ? 1 : -1;
}

export function buildGeneralLedger(
  lines: LedgerSourceLine[],
  account: { code: number; name: string; kind: AccountKind },
  accountName: (code: number) => string,
  opening = 0,
): GeneralLedger {
  const sign = balanceSign(account.kind);
  let balance = opening;
  let debitTotal = 0;
  let creditTotal = 0;
  const out: GeneralLedgerLine[] = [];

  const sorted = [...lines].sort((a, b) =>
    a.entry_date.localeCompare(b.entry_date) || a.no - b.no || a.id - b.id);

  for (const l of sorted) {
    const isDebit = l.debit_code === account.code;
    const isCredit = l.credit_code === account.code;
    if (!isDebit && !isCredit) continue;
    // 同一科目が借貸両方に出る自己振替は 2 行に分けて出す
    if (isDebit) {
      balance += sign * l.debit_amount;
      debitTotal += l.debit_amount;
      out.push({
        entry_id: l.id, entry_date: l.entry_date, no: l.no,
        counter_code: l.credit_code, counter_name: accountName(l.credit_code),
        description: l.description, debit: l.debit_amount, credit: 0, balance,
      });
    }
    if (isCredit) {
      balance -= sign * l.credit_amount;
      creditTotal += l.credit_amount;
      out.push({
        entry_id: l.id, entry_date: l.entry_date, no: l.no,
        counter_code: l.debit_code, counter_name: accountName(l.debit_code),
        description: l.description, debit: 0, credit: l.credit_amount, balance,
      });
    }
  }

  return {
    code: account.code, name: account.name, kind: account.kind,
    opening, lines: out, debit_total: debitTotal, credit_total: creditTotal, closing: balance,
  };
}
