/**
 * 行動解析 — 既存の transactions + receipts から「よく使う店」を集計する。
 *
 * 入力源:
 *  - transactions (is_transfer=0, amount_out>0, payee あり) … 支出の正本台帳
 *  - receipts (committed_at あり, payee/total あり) のうち、 reconciliations で
 *    tx に紐付いていないもの … 現金払い等で台帳に出ない分を補完
 *
 * reconcile 済レシートは対応 tx 側で数えるため、 二重計上を避ける。
 * 集約キーは normalizePayee (店名の表記揺れを吸収)。
 */

import type Database from "better-sqlite3";
import { normalizePayee } from "../shared/text.js";

export interface BehaviorFilter {
  from?: string;        // ISO yyyy-mm-dd 含む
  to?: string;          // ISO yyyy-mm-dd 含む
  limit?: number;       // 上位何件 (既定 30)
  minVisits?: number;   // この回数未満を除外 (既定 1)
}

export type BehaviorSource = "transaction" | "receipt";

export interface BehaviorEntry {
  payee_norm: string;
  payee_sample: string;   // 表示用の生表記 (最初に出会ったもの)
  visits: number;         // 利用回数
  total_spend: number;    // 累計支出 (円)
  sources: BehaviorSource[];
}

interface Accum {
  payee_sample: string;
  visits: number;
  total_spend: number;
  sources: Set<BehaviorSource>;
}

/** transactions + 未 reconcile receipts を payee で集約し、 支出順ランキングを返す。 */
export function analyzeBehavior(db: Database.Database, filter: BehaviorFilter = {}): BehaviorEntry[] {
  const acc = new Map<string, Accum>();

  const add = (rawPayee: string, spend: number, source: BehaviorSource) => {
    const key = normalizePayee(rawPayee);
    if (!key) return;
    let a = acc.get(key);
    if (!a) {
      a = { payee_sample: rawPayee.trim(), visits: 0, total_spend: 0, sources: new Set() };
      acc.set(key, a);
    }
    a.visits += 1;
    a.total_spend += spend;
    a.sources.add(source);
  };

  // transactions: 出金のみ、 振替を除外
  const txWhere = ["is_transfer = 0", "amount_out IS NOT NULL", "amount_out > 0", "payee IS NOT NULL"];
  const txParams: Record<string, unknown> = {};
  if (filter.from) { txWhere.push("date >= @from"); txParams.from = filter.from; }
  if (filter.to) { txWhere.push("date <= @to"); txParams.to = filter.to; }
  const txRows = db
    .prepare(`SELECT payee, amount_out FROM transactions WHERE ${txWhere.join(" AND ")}`)
    .all(txParams) as { payee: string; amount_out: number }[];
  for (const r of txRows) add(r.payee, r.amount_out, "transaction");

  // receipts: 投入済 かつ 未 reconcile のみ (reconcile 済は tx 側で計上済)
  const rcWhere = [
    "committed_at IS NOT NULL",
    "payee IS NOT NULL",
    "total IS NOT NULL",
    "id NOT IN (SELECT receipt_id FROM reconciliations)",
  ];
  const rcParams: Record<string, unknown> = {};
  if (filter.from) { rcWhere.push("date >= @from"); rcParams.from = filter.from; }
  if (filter.to) { rcWhere.push("date <= @to"); rcParams.to = filter.to; }
  const rcRows = db
    .prepare(`SELECT payee, total FROM receipts WHERE ${rcWhere.join(" AND ")}`)
    .all(rcParams) as { payee: string; total: number }[];
  for (const r of rcRows) add(r.payee, r.total, "receipt");

  const minVisits = filter.minVisits ?? 1;
  const limit = filter.limit ?? 30;
  return [...acc.entries()]
    .map(([payee_norm, a]) => ({
      payee_norm,
      payee_sample: a.payee_sample,
      visits: a.visits,
      total_spend: a.total_spend,
      sources: [...a.sources],
    }))
    .filter((e) => e.visits >= minVisits)
    .sort((x, y) => y.total_spend - x.total_spend || y.visits - x.visits)
    .slice(0, limit);
}
