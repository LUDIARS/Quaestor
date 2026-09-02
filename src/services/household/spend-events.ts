/**
 * 支出イベントの組立。 家計分析の集計単位。
 *
 *  - transactions (is_transfer=0, amount_out>0) を 1 イベントにし、 reconciliations で突合済の
 *    レシートがあればその GPS / 品目を添える (金額は取引側が正)
 *  - 未突合の投入済レシート (committed_at) は現金払い等として別イベントにする
 *
 * 二重計上回避は behavior-analysis.ts と同じ規則 (突合済レシートは取引側で数える)。
 *
 * @implements SPEC-HOUSEHOLD-ANALYSIS-001 (spec/feature/household-bookkeeping.md)
 */

import type Database from "better-sqlite3";
import type { ReceiptItem } from "../../db/receipts-repo.js";
import { normalizePayee } from "../../shared/text.js";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface SpendEvent {
  id: string;
  date: string;
  payee: string;
  payee_norm: string;
  amount: number;
  kind: "transaction" | "receipt";
  /** 決済手段の表示名 (account があればそれ、 無ければ source) */
  method: string;
  receipt_id: string | null;
  geo: GeoPoint | null;
  items: ReceiptItem[] | null;
}

interface TxRow {
  id: string;
  date: string;
  payee: string | null;
  description: string;
  amount_out: number;
  source: string;
  account: string | null;
  receipt_id: string | null;
  geo: string | null;
  items: string | null;
}

interface ReceiptRow {
  id: string;
  date: string;
  payee: string | null;
  total: number;
  geo: string | null;
  items: string | null;
}

export function parseGeo(json: string | null): GeoPoint | null {
  if (!json) return null;
  try {
    const g = JSON.parse(json) as { lat?: unknown; lon?: unknown };
    if (typeof g.lat === "number" && typeof g.lon === "number" && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
      return { lat: g.lat, lon: g.lon };
    }
  } catch { /* 壊れた JSON は位置無しとして扱う (受口側で検証済みのはずだが、 分析は落とさない) */ }
  return null;
}

function parseItems(json: string | null): ReceiptItem[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as ReceiptItem[]) : null;
  } catch { /* 同上 */ return null; }
}

export function collectSpendEvents(db: Database.Database, range: { from: string; to: string }): SpendEvent[] {
  const txRows = db
    .prepare(
      `SELECT t.id, t.date, t.payee, t.description, t.amount_out, t.source, t.account,
              r.id AS receipt_id, r.geo, r.items
       FROM transactions t
       LEFT JOIN (SELECT transaction_id, MIN(receipt_id) AS receipt_id FROM reconciliations GROUP BY transaction_id) x
         ON x.transaction_id = t.id
       LEFT JOIN receipts r ON r.id = x.receipt_id
       WHERE t.is_transfer = 0 AND t.amount_out IS NOT NULL AND t.amount_out > 0
         AND t.date >= ? AND t.date <= ?
       ORDER BY t.date ASC, t.created_at ASC`,
    )
    .all(range.from, range.to) as TxRow[];

  const rcRows = db
    .prepare(
      `SELECT id, date, payee, total, geo, items FROM receipts
       WHERE committed_at IS NOT NULL AND date IS NOT NULL AND total IS NOT NULL AND total > 0
         AND id NOT IN (SELECT receipt_id FROM reconciliations)
         AND date >= ? AND date <= ?
       ORDER BY date ASC, captured_at ASC`,
    )
    .all(range.from, range.to) as ReceiptRow[];

  const events: SpendEvent[] = [];
  for (const t of txRows) {
    const payee = (t.payee ?? t.description).trim();
    events.push({
      id: `tx:${t.id}`,
      date: t.date,
      payee,
      payee_norm: normalizePayee(payee),
      amount: t.amount_out,
      kind: "transaction",
      method: t.account ?? t.source,
      receipt_id: t.receipt_id,
      geo: parseGeo(t.geo),
      items: parseItems(t.items),
    });
  }
  for (const r of rcRows) {
    const payee = (r.payee ?? "").trim() || "(レシート)";
    events.push({
      id: `receipt:${r.id}`,
      date: r.date,
      payee,
      payee_norm: normalizePayee(payee),
      amount: r.total,
      kind: "receipt",
      method: "現金 (レシート)",
      receipt_id: r.id,
      geo: parseGeo(r.geo),
      items: parseItems(r.items),
    });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
