/**
 * Receipt × Transaction の照合エンジン。
 *
 * - 候補絞込: receipt.date ± N 日 (既定 3 日)
 * - スコア = w_date * date_score + w_amount * amount_score + w_payee * payee_score
 * - 既に reconciled 済の transaction は除外 (1:1 ペアリング前提、 split bill は v1 で対応)
 *
 * 信頼度バンド:
 *   ≥ 0.85: auto-match 推奨
 *   0.50 ≤ x < 0.85: ユーザに見せて承認待ち
 *   < 0.50: 候補から除外
 */

import type Database from "better-sqlite3";
import type { ReceiptRow } from "../db/receipts-repo.js";
import type { TransactionRow } from "../shared/types.js";
import { normalizePayee } from "../shared/text.js";
import { similarity } from "../shared/levenshtein.js";

export interface MatchScore {
  date_score: number;
  amount_score: number;
  payee_score: number;
  total: number;
}

export interface MatchCandidate {
  transaction: TransactionRow;
  score: MatchScore;
}

export interface MatchOptions {
  daysWindow?: number;          // 既定 3
  amountToleranceRel?: number;  // 既定 0.05 (5%)
  weights?: { date: number; amount: number; payee: number };
  minScore?: number;            // 既定 0.5 (これ未満は候補から外す)
  topK?: number;                // 既定 5
  /** 既に reconciled 済の tx_id を除外する */
  excludeTxIds?: Set<string>;
}

export const DEFAULTS: Required<Omit<MatchOptions, "excludeTxIds">> = {
  daysWindow: 3,
  amountToleranceRel: 0.05,
  weights: { date: 0.4, amount: 0.4, payee: 0.2 },
  minScore: 0.5,
  topK: 5,
};

/**
 * receipt の照合候補を transactions テーブルから探す。
 * receipt.date / receipt.total が両方 null だと date filter が効かないので空配列を返す。
 */
export function findCandidates(
  db: Database.Database,
  receipt: ReceiptRow,
  opts: MatchOptions = {},
): MatchCandidate[] {
  const o = { ...DEFAULTS, ...opts, weights: { ...DEFAULTS.weights, ...opts.weights } };

  if (!receipt.date) return [];   // 日付不明は候補無し
  if (receipt.total == null) return [];

  const dateFrom = addDays(receipt.date, -o.daysWindow);
  const dateTo = addDays(receipt.date, o.daysWindow);

  // amount_out が receipt.total に近い tx を絞る (5% tolerance に少し余裕を持たせる)
  const amountLow = Math.floor(receipt.total * (1 - o.amountToleranceRel * 1.5));
  const amountHigh = Math.ceil(receipt.total * (1 + o.amountToleranceRel * 1.5));

  // 既に reconciled 済の transaction を除外する SQL を構築
  const exclude = opts.excludeTxIds ?? alreadyReconciledTxIds(db, receipt.id);
  const excludeArr = [...exclude];
  const excludeSql = excludeArr.length > 0
    ? ` AND id NOT IN (${excludeArr.map(() => "?").join(",")})`
    : "";

  const rows = db
    .prepare(
      `SELECT * FROM transactions
       WHERE date >= ? AND date <= ?
         AND amount_out IS NOT NULL
         AND amount_out >= ? AND amount_out <= ?
       ${excludeSql}
       ORDER BY date DESC`,
    )
    .all(dateFrom, dateTo, amountLow, amountHigh, ...excludeArr) as TransactionRow[];

  const receiptPayee = normalizePayee(receipt.payee);
  const candidates: MatchCandidate[] = [];
  for (const tx of rows) {
    const score = scoreMatch(receipt, tx, receiptPayee, o);
    if (score.total >= o.minScore) {
      candidates.push({ transaction: tx, score });
    }
  }
  candidates.sort((a, b) => b.score.total - a.score.total);
  return candidates.slice(0, o.topK);
}

function scoreMatch(
  receipt: ReceiptRow,
  tx: TransactionRow,
  normalizedReceiptPayee: string,
  opts: Required<Omit<MatchOptions, "excludeTxIds">>,
): MatchScore {
  const days = Math.abs(daysDiff(receipt.date!, tx.date));
  const date_score = Math.max(0, 1 - days / opts.daysWindow);

  const txAmount = tx.amount_out ?? 0;
  const ratio = Math.abs(txAmount - receipt.total!) / receipt.total!;
  const amount_score = ratio === 0
    ? 1
    : Math.max(0, 1 - ratio / opts.amountToleranceRel);

  const txPayee = normalizePayee(tx.payee);
  // payee 片方欠損なら 0.5 で中立扱い (ペナルティ過大を避ける)
  const payee_score = (!normalizedReceiptPayee || !txPayee)
    ? 0.5
    : similarity(normalizedReceiptPayee, txPayee);

  const total =
    opts.weights.date * date_score +
    opts.weights.amount * amount_score +
    opts.weights.payee * payee_score;
  return { date_score, amount_score, payee_score, total };
}

function alreadyReconciledTxIds(db: Database.Database, receiptId: string): Set<string> {
  // この receipt を除いた他の reconciliations にぶら下がる tx を取得
  const rows = db
    .prepare(`SELECT transaction_id FROM reconciliations WHERE receipt_id != ?`)
    .all(receiptId) as { transaction_id: string }[];
  return new Set(rows.map((r) => r.transaction_id));
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysDiff(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((da - db) / 86_400_000);
}
