/**
 * 行動解析 — 既存の transactions + receipts から「よく使う店」を集計する。
 *
 * 入力源:
 *  - transactions (is_transfer=0, amount_out>0, payee あり) … 支出の正本台帳
 *    クレカ明細が主な供給源。 source フィルタで絞れる。
 *  - receipts (committed_at あり, payee/total あり) のうち、 reconciliations で
 *    tx に紐付いていないもの … 現金払い等で台帳に出ない分を補完
 *
 * reconcile 済レシートは対応 tx 側で数えるため、 二重計上を避ける。
 * 集約キーは normalizePayee (店名の表記揺れを吸収)。
 *
 * クレカ明細は「先月分を当月取込」と 1 ヶ月遅れで入るため、 from/to 未指定時は
 * 「データのある最終月から直近 N ヶ月」 を既定窓にして、 当月の空データを除外する。
 */

import type Database from "better-sqlite3";
import type { SourceKind } from "../shared/types.js";
import { normalizePayee } from "../shared/text.js";

export interface BehaviorFilter {
  from?: string;        // ISO yyyy-mm-dd 含む
  to?: string;          // ISO yyyy-mm-dd 含む
  limit?: number;       // 上位何件 (既定 30)
  minVisits?: number;   // この回数未満を除外 (既定 1)
  /** transactions.source の絞り込み。 'receipt' を含めるとレシートも対象 */
  source?: SourceKind | SourceKind[];
  /** from/to 未指定時の既定窓 (直近 N 完了月)。 既定 6、 0 で全期間 */
  months?: number;
}

export type BehaviorSource = "transaction" | "receipt";

export interface BehaviorEntry {
  payee_norm: string;
  payee_sample: string;   // 表示用の生表記 (最初に出会ったもの)
  visits: number;         // 利用回数
  total_spend: number;    // 累計支出 (円)
  sources: BehaviorSource[];
}

export interface DataCoverage {
  months: string[];       // データのある YYYY-MM (昇順)
  latest: string | null;  // 最新の完了月 YYYY-MM
  earliest: string | null;
}

export interface ResolvedRange {
  from?: string;
  to?: string;
}

interface Accum {
  payee_sample: string;
  visits: number;
  total_spend: number;
  sources: Set<BehaviorSource>;
}

/** source 指定を配列に正規化 (undefined はそのまま) */
function normalizeSources(source?: SourceKind | SourceKind[]): SourceKind[] | undefined {
  if (source === undefined) return undefined;
  return Array.isArray(source) ? source : [source];
}

/** transactions に適用する source 群 ('receipt' は tx の source ではないので除外) */
function txSources(sources: SourceKind[] | undefined): SourceKind[] | undefined {
  if (sources === undefined) return undefined;
  return sources.filter((s) => s !== "receipt");
}

/** receipts を含めるか (source 未指定 or 'receipt' を含む時) */
function shouldIncludeReceipts(sources: SourceKind[] | undefined): boolean {
  return sources === undefined || sources.includes("receipt");
}

/**
 * データのある月 (YYYY-MM) を列挙する。 source 指定時は transactions のみ対象、
 * 未指定なら committed receipts も含める。 既定窓の算出に使う。
 */
export function dataCoverage(db: Database.Database, source?: SourceKind | SourceKind[]): DataCoverage {
  const sources = normalizeSources(source);
  const monthSet = new Set<string>();

  const txs = txSources(sources);
  if (txs === undefined || txs.length > 0) {
    const where = ["is_transfer = 0", "amount_out IS NOT NULL", "amount_out > 0", "payee IS NOT NULL"];
    const params: unknown[] = [];
    if (txs && txs.length > 0) {
      where.push(`source IN (${txs.map(() => "?").join(",")})`);
      params.push(...txs);
    }
    const rows = db
      .prepare(`SELECT DISTINCT substr(date, 1, 7) AS m FROM transactions WHERE ${where.join(" AND ")}`)
      .all(...params) as { m: string }[];
    for (const r of rows) if (/^\d{4}-\d{2}$/.test(r.m)) monthSet.add(r.m);
  }

  if (shouldIncludeReceipts(sources)) {
    const rows = db
      .prepare(
        `SELECT DISTINCT substr(date, 1, 7) AS m FROM receipts
         WHERE committed_at IS NOT NULL AND date IS NOT NULL AND total IS NOT NULL`,
      )
      .all() as { m: string }[];
    for (const r of rows) if (/^\d{4}-\d{2}$/.test(r.m)) monthSet.add(r.m);
  }

  const months = [...monthSet].sort();
  return {
    months,
    latest: months.length ? months[months.length - 1]! : null,
    earliest: months.length ? months[0]! : null,
  };
}

/**
 * from/to が未指定なら「データのある最終月から直近 months ヶ月」を窓にする。
 * months=0 や データ無しなら制約なし。
 */
export function resolveRange(db: Database.Database, filter: BehaviorFilter): ResolvedRange {
  if (filter.from || filter.to) return { from: filter.from, to: filter.to };
  const months = filter.months ?? 6;
  if (months <= 0) return {};
  const cov = dataCoverage(db, filter.source);
  if (!cov.latest) return {};
  return {
    from: `${addMonths(cov.latest, -(months - 1))}-01`,
    to: `${cov.latest}-31`,
  };
}

/** transactions + 未 reconcile receipts を payee で集約し、 支出順ランキングを返す。 */
export function analyzeBehavior(db: Database.Database, filter: BehaviorFilter = {}): BehaviorEntry[] {
  const sources = normalizeSources(filter.source);
  const { from, to } = resolveRange(db, filter);
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

  // transactions: 出金のみ、 振替を除外、 source 絞り込み
  const txs = txSources(sources);
  if (txs === undefined || txs.length > 0) {
    const where = ["is_transfer = 0", "amount_out IS NOT NULL", "amount_out > 0", "payee IS NOT NULL"];
    const params: unknown[] = [];
    if (txs && txs.length > 0) {
      where.push(`source IN (${txs.map(() => "?").join(",")})`);
      params.push(...txs);
    }
    if (from) { where.push("date >= ?"); params.push(from); }
    if (to) { where.push("date <= ?"); params.push(to); }
    const txRows = db
      .prepare(`SELECT payee, amount_out FROM transactions WHERE ${where.join(" AND ")}`)
      .all(...params) as { payee: string; amount_out: number }[];
    for (const r of txRows) add(r.payee, r.amount_out, "transaction");
  }

  // receipts: 投入済 かつ 未 reconcile のみ (reconcile 済は tx 側で計上済)
  if (shouldIncludeReceipts(sources)) {
    const where = [
      "committed_at IS NOT NULL",
      "payee IS NOT NULL",
      "total IS NOT NULL",
      "id NOT IN (SELECT receipt_id FROM reconciliations)",
    ];
    const params: unknown[] = [];
    if (from) { where.push("date >= ?"); params.push(from); }
    if (to) { where.push("date <= ?"); params.push(to); }
    const rcRows = db
      .prepare(`SELECT payee, total FROM receipts WHERE ${where.join(" AND ")}`)
      .all(...params) as { payee: string; total: number }[];
    for (const r of rcRows) add(r.payee, r.total, "receipt");
  }

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

/** YYYY-MM に delta ヶ月を加算した YYYY-MM を返す。 */
export function addMonths(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}
