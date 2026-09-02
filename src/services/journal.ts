/**
 * transactions + apportionment_rules.resolve から「仕訳帳」 (calc 互換) を生成。
 *
 * 仕訳生成ロジック (spec/data/account-codes.md より):
 *   rate=1.0 (100% 経費):
 *     借方 <経費code>(amount) / 貸方 102 当座預金 (amount)、 摘要=店名
 *   0 < rate < 1 (一部経費):
 *     借方 <経費code>(amount*rate)         / 貸方 102 (amount*rate)、 摘要=店名
 *     借方 124 事業主貸 (amount*(1-rate))   / 貸方 102 (amount*(1-rate))、 摘要="クレカ引き落とし調整"
 *   rate=0 (家計):
 *     借方 124 事業主貸 (amount)            / 貸方 102 (amount)、 摘要="クレカ引き落とし調整"
 *
 * 現金支払 (account=現金) の場合、 貸方を 102 → 101 に置換する。
 *
 * source=bank の入金 (amount_in) は売上扱いとして:
 *     借方 102 当座預金 (amount_in) / 貸方 1 売上 (amount_in)
 * (実運用では振込元の判別が必要だが、 v1.0 では一律 売上 として export し、
 *   ユーザが Excel 上で修正する想定)
 */

import type Database from "better-sqlite3";
import type { TransactionRow } from "../shared/types.js";
import type { ApportionmentRulesRepo } from "../db/apportionment-rules-repo.js";
import type { JournalLeg } from "../db/journal-entries-repo.js";

export interface JournalEntry {
  /** 仕訳番号 (連番) */
  no: number;
  /** ISO yyyy-mm-dd */
  date: string;
  debit_code: number;
  debit_name: string;
  debit_amount: number;
  credit_code: number;
  credit_name: string;
  credit_amount: number;
  description: string;
  /** 計算用支払額 (列 K) — 元取引金額 */
  payment: number;
  /** 按分率 (列 L) — 0..1 */
  rate: number;
  /** 元 transaction id (帳簿外、 trace 用) */
  source_tx_id: string;
  /** この行が取引のどの脚か (経費 / 家計 = 事業主貸 / 入金)。 永続化と家計費目付与に使う */
  leg: JournalLeg;
  /** 元取引の payee (家計費目の解決用、 摘要が固定文言になる家計行でも店名を保つ) */
  payee: string | null;
}

export interface AccountCodeMap {
  [code: number]: string;
}

export interface BuildJournalOptions {
  /** ISO yyyy-mm-dd 含む */
  date_from?: string;
  date_to?: string;
  /** 支払元勘定 (current_account)。 通常は 102 当座預金、 現金支払の場合は 101 */
  defaultCreditCode?: number;
  /** 仕訳番号の起点 (既定 1) */
  startNo?: number;
  /** account_codes 名前解決マップ (DB から拾って渡す) */
  accountNames: AccountCodeMap;
}

/**
 * transactions を全件 (or 期間指定) で読んで仕訳エントリ配列に変換。
 * apportionment_rules.resolve(payee) で {rate, code} を引き、 仕訳パターンを展開する。
 */
export function buildJournal(
  db: Database.Database,
  rules: ApportionmentRulesRepo,
  opts: BuildJournalOptions,
): JournalEntry[] {
  const where: string[] = ["is_transfer = 0"];
  const params: unknown[] = [];
  if (opts.date_from) { where.push("date >= ?"); params.push(opts.date_from); }
  if (opts.date_to) { where.push("date <= ?"); params.push(opts.date_to); }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const txs = db
    .prepare(`SELECT * FROM transactions ${whereSql} ORDER BY date ASC, created_at ASC`)
    .all(...params) as TransactionRow[];

  const defaultCredit = opts.defaultCreditCode ?? 102;
  const accountName = (code: number) => opts.accountNames[code] ?? `(unknown ${code})`;

  const out: JournalEntry[] = [];
  let no = opts.startNo ?? 1;

  for (const tx of txs) {
    // 出金 (経費 / 家計) と 入金 (売上仮置き) を分けて扱う
    if (tx.amount_out != null && tx.amount_out > 0) {
      const { rate, code } = rules.resolve(tx.payee);
      const creditCode = chooseCreditCode(tx, defaultCredit);
      const expensePart = Math.round(tx.amount_out * rate);
      const householdPart = tx.amount_out - expensePart;

      if (rate >= 1.0) {
        // 100% 経費 1 行
        out.push(makeEntry(no++, tx, code, expensePart, creditCode, expensePart, tx.payee ?? tx.description, rate, accountName, "expense"));
      } else if (rate > 0) {
        // 経費部分
        out.push(makeEntry(no++, tx, code, expensePart, creditCode, expensePart, tx.payee ?? tx.description, rate, accountName, "expense"));
        // 家計部分
        out.push(makeEntry(no++, tx, 124, householdPart, creditCode, householdPart, "クレカ引き落とし調整", rate, accountName, "household"));
      } else {
        // 家計のみ
        out.push(makeEntry(no++, tx, 124, tx.amount_out, creditCode, tx.amount_out, "クレカ引き落とし調整", rate, accountName, "household"));
      }
    }
    if (tx.amount_in != null && tx.amount_in > 0) {
      // 銀行入金 → 売上仮置き
      out.push(makeEntry(no++, tx, defaultCredit, tx.amount_in, 1, tx.amount_in, tx.payee ?? tx.description, 1.0, accountName, "income"));
    }
  }

  return out;
}

function makeEntry(
  no: number,
  tx: TransactionRow,
  debit: number,
  debitAmount: number,
  credit: number,
  creditAmount: number,
  desc: string,
  rate: number,
  accountName: (c: number) => string,
  leg: JournalLeg,
): JournalEntry {
  return {
    no,
    date: tx.date,
    debit_code: debit,
    debit_name: accountName(debit),
    debit_amount: debitAmount,
    credit_code: credit,
    credit_name: accountName(credit),
    credit_amount: creditAmount,
    description: desc,
    payment: tx.amount_out ?? tx.amount_in ?? 0,
    rate,
    source_tx_id: tx.id,
    leg,
    payee: tx.payee,
  };
}

/**
 * 取引の支払元口座を決める。
 *   account ラベルに「現金」が含まれる → 101
 *   それ以外 → defaultCredit (通常 102 当座預金)
 */
function chooseCreditCode(tx: TransactionRow, defaultCredit: number): number {
  if (tx.account && /現金|cash/i.test(tx.account)) return 101;
  return defaultCredit;
}
