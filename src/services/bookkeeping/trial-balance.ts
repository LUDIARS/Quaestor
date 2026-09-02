/**
 * 精算表 (エクセル簿記「精算表」シート互換)。 仕訳帳からの純関数。
 *
 * Excel 側の式:
 *   H (借方合計) = SUMIF(仕訳帳!D, code, 仕訳帳!F)
 *   I (貸方合計) = SUMIF(仕訳帳!G, code, 仕訳帳!I)
 *   損益科目 (収益/費用):  J = max(H-I, 0)  K = max(I-H, 0)
 *   資産科目:             L = 期首借方 - 期首貸方 + H - I
 *   負債・資本科目:       M = 期首貸方 - 期首借方 + I - H
 *   所得 (青色申告特別控除前) = ΣK - ΣJ。 貸借を合わせる諸口行として PL 借方 / BS 貸方に載る。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-003 (spec/feature/household-bookkeeping.md)
 */

import type { AccountKind } from "../../db/seed.js";

export interface LedgerLine {
  debit_code: number;
  debit_amount: number;
  credit_code: number;
  credit_amount: number;
}

export interface AccountInfo {
  code: number;
  name: string;
  kind: AccountKind;
}

/** 期首残高 (④ 貸借対照表の期首列)。 資産は借方、 負債・資本は貸方に入れる。 */
export interface OpeningBalance {
  debit: number;
  credit: number;
}

export interface TrialBalanceRow {
  code: number;
  name: string;
  kind: AccountKind;
  opening_debit: number;
  opening_credit: number;
  debit_total: number;
  credit_total: number;
  pl_debit: number;
  pl_credit: number;
  bs_debit: number;
  bs_credit: number;
}

export interface TrialBalanceTotals {
  opening_debit: number;
  opening_credit: number;
  debit_total: number;
  credit_total: number;
  pl_debit: number;
  pl_credit: number;
  bs_debit: number;
  bs_credit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  /** 科目行だけの合計 (Excel の「準計」) */
  subtotal: TrialBalanceTotals;
  /** 青色申告特別控除前の所得金額 = 収益 − 費用 */
  income: number;
  /** 科目行にない期首資産・負債差額。資本側の元入金として表示する。 */
  opening_equity: number;
  /** 所得行を含めた合計 (Excel の「合計」)。 PL 借方 = PL 貸方、 BS 借方 = BS 貸方 になる */
  total: TrialBalanceTotals;
  /** 仕訳帳に出てくるが account_codes に無い科目コード (Excel の「科目コードにない文字」警告相当) */
  unknown_codes: number[];
}

const ZERO: TrialBalanceTotals = {
  opening_debit: 0, opening_credit: 0, debit_total: 0, credit_total: 0,
  pl_debit: 0, pl_credit: 0, bs_debit: 0, bs_credit: 0,
};

function isPl(kind: AccountKind): boolean {
  return kind === "revenue" || kind === "expense";
}

export function computeTrialBalance(
  lines: LedgerLine[],
  accounts: AccountInfo[],
  opening: ReadonlyMap<number, OpeningBalance> = new Map(),
): TrialBalance {
  const debitSum = new Map<number, number>();
  const creditSum = new Map<number, number>();
  for (const l of lines) {
    debitSum.set(l.debit_code, (debitSum.get(l.debit_code) ?? 0) + l.debit_amount);
    creditSum.set(l.credit_code, (creditSum.get(l.credit_code) ?? 0) + l.credit_amount);
  }

  const known = new Set(accounts.map((a) => a.code));
  const unknown = new Set<number>();
  for (const c of [...debitSum.keys(), ...creditSum.keys()]) if (!known.has(c)) unknown.add(c);

  const rows: TrialBalanceRow[] = [];
  for (const a of [...accounts].sort((x, y) => x.code - y.code)) {
    const op = opening.get(a.code) ?? { debit: 0, credit: 0 };
    const d = debitSum.get(a.code) ?? 0;
    const c = creditSum.get(a.code) ?? 0;
    const row: TrialBalanceRow = {
      code: a.code, name: a.name, kind: a.kind,
      opening_debit: op.debit, opening_credit: op.credit,
      debit_total: d, credit_total: c,
      pl_debit: 0, pl_credit: 0, bs_debit: 0, bs_credit: 0,
    };
    if (isPl(a.kind)) {
      row.pl_debit = Math.max(d - c, 0);
      row.pl_credit = Math.max(c - d, 0);
    } else if (a.kind === "asset") {
      row.bs_debit = op.debit - op.credit + d - c;
    } else {
      row.bs_credit = op.credit - op.debit + c - d;
    }
    // 期首も動きも無い科目は Excel と同じく空行扱い (rows には残すが数値は 0)
    rows.push(row);
  }

  const subtotal = rows.reduce<TrialBalanceTotals>((acc, r) => ({
    opening_debit: acc.opening_debit + r.opening_debit,
    opening_credit: acc.opening_credit + r.opening_credit,
    debit_total: acc.debit_total + r.debit_total,
    credit_total: acc.credit_total + r.credit_total,
    pl_debit: acc.pl_debit + r.pl_debit,
    pl_credit: acc.pl_credit + r.pl_credit,
    bs_debit: acc.bs_debit + r.bs_debit,
    bs_credit: acc.bs_credit + r.bs_credit,
  }), { ...ZERO });

  const income = subtotal.pl_credit - subtotal.pl_debit;
  // Opening assets not backed by an opening liability are the proprietor's
  // opening equity. It is implicit because account_codes has no separate
  // capital kind, but it must participate in the BS total.
  const openingEquity = subtotal.opening_debit - subtotal.opening_credit;
  // 所得が正なら PL 借方 / BS 貸方 に、 負 (損失) なら PL 貸方 / BS 借方 に諸口行を置く
  const total: TrialBalanceTotals = {
    ...subtotal,
    pl_debit: subtotal.pl_debit + Math.max(income, 0),
    pl_credit: subtotal.pl_credit + Math.max(-income, 0),
    bs_debit: subtotal.bs_debit + Math.max(-income, 0) + Math.max(-openingEquity, 0),
    bs_credit: subtotal.bs_credit + Math.max(income, 0) + Math.max(openingEquity, 0),
  };

  return { rows, subtotal, income, opening_equity: openingEquity, total, unknown_codes: [...unknown].sort((a, b) => a - b) };
}
