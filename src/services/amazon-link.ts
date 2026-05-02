/**
 * クレカ取引 (payee に "AMAZON" を含む) を Amazon Order History の取引行に紐づけるサービス。
 *
 * 仕組み:
 *   - cc tx の payee を normalize して「Amazon 系」 と判定
 *   - 同 ± N 日 (既定 3) で source='amazon' の取引を検索
 *   - 金額が一致する候補を返す (税込/送料込で揺れることがあるので ±3% tolerance)
 *   - 複数候補がある場合は score (date 近さ + amount 一致度) で並べる
 */

import type Database from "better-sqlite3";
import type { TransactionRow } from "../shared/types.js";
import { normalizePayee } from "../shared/text.js";

export interface AmazonLinkCandidate {
  transaction: TransactionRow;
  /** parsed metadata.items (Amazon Order History 由来) */
  items: Array<{ product: string; total_owed: number; qty: number; unit_price?: number; unit_tax?: number }>;
  order_id: string | null;
  ship_date: string | null;
  /** 0..1, 高いほど一致確度高 */
  confidence: number;
  date_diff_days: number;
  amount_diff: number;
}

const AMAZON_PAYEE = /AMAZON/;

export interface FindOptions {
  daysWindow?: number;        // 既定 3
  amountToleranceRel?: number; // 既定 0.03 (3%)
  limit?: number;              // 既定 5
}

export function isAmazonCcTx(tx: TransactionRow): boolean {
  if (tx.source !== "credit-card") return false;
  return AMAZON_PAYEE.test(normalizePayee(tx.payee));
}

export function findAmazonLink(
  db: Database.Database,
  ccTx: TransactionRow,
  opts: FindOptions = {},
): AmazonLinkCandidate[] {
  const days = opts.daysWindow ?? 3;
  const amountTol = opts.amountToleranceRel ?? 0.03;
  const limit = opts.limit ?? 5;

  if (!isAmazonCcTx(ccTx) || ccTx.amount_out == null) return [];

  const dateFrom = addDays(ccTx.date, -days);
  const dateTo = addDays(ccTx.date, days);
  const lo = Math.floor(ccTx.amount_out * (1 - amountTol * 1.5));
  const hi = Math.ceil(ccTx.amount_out * (1 + amountTol * 1.5));

  const rows = db
    .prepare(
      `SELECT * FROM transactions
       WHERE source = 'amazon'
         AND is_transfer = 0
         AND date >= ? AND date <= ?
         AND amount_out IS NOT NULL
         AND amount_out >= ? AND amount_out <= ?`,
    )
    .all(dateFrom, dateTo, lo, hi) as TransactionRow[];

  const out: AmazonLinkCandidate[] = [];
  for (const r of rows) {
    const meta = parseMeta(r.metadata);
    const items = Array.isArray(meta.items) ? meta.items : [];
    const ddiff = Math.abs(daysDiff(ccTx.date, r.date));
    const amtDiff = Math.abs((r.amount_out ?? 0) - ccTx.amount_out);
    const ratio = amtDiff / ccTx.amount_out;
    const dateScore = Math.max(0, 1 - ddiff / days);
    const amountScore = ratio === 0 ? 1 : Math.max(0, 1 - ratio / amountTol);
    const confidence = 0.5 * dateScore + 0.5 * amountScore;
    out.push({
      transaction: r,
      items: items as AmazonLinkCandidate["items"],
      order_id: typeof meta.order_id === "string" ? meta.order_id : null,
      ship_date: typeof meta.ship_date === "string" ? meta.ship_date : null,
      confidence,
      date_diff_days: ddiff,
      amount_diff: amtDiff,
    });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, limit);
}

function parseMeta(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysDiff(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const dbb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((da - dbb) / 86_400_000);
}
