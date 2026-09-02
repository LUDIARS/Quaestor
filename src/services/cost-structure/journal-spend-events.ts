/**
 * 取引の無い月を取込済み仕訳 (origin=imported の経費 / 家計行) で補う支出イベント。
 * 2025.xlsx 由来の過去分をビューに出すため。 同じ月に取引があれば仕訳は使わない (二重計上回避)。
 * @implements SPEC-COST-STRUCTURE-002 (spec/feature/cost-structure.md)
 */

import type Database from "better-sqlite3";
import { normalizePayee } from "../../shared/text.js";
import type { SpendEvent } from "../household/spend-events.js";

const HOUSEHOLD_ADJUSTMENT_DESCRIPTION = "クレカ引き落とし調整";

interface JournalSpendRow {
  id: number;
  entry_date: string;
  description: string;
  payment: number;
  leg: "expense" | "household";
}

/** 取引 (出金) が 1 件でもある月 (YYYY-MM) */
export function monthsWithTransactions(db: Database.Database, range: { from: string; to: string }): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(date, 1, 7) AS m FROM transactions
       WHERE is_transfer = 0 AND amount_out IS NOT NULL AND amount_out > 0 AND date >= ? AND date <= ?`,
    )
    .all(range.from, range.to) as { m: string }[];
  return new Set(rows.map((r) => r.m));
}

export function collectJournalSpendEvents(db: Database.Database, range: { from: string; to: string }, skipMonths: Set<string>): SpendEvent[] {
  const rows = db
    .prepare(
      `SELECT id, entry_date, description, payment, leg FROM journal_entries
       WHERE origin = 'imported' AND leg IN ('expense', 'household') AND payment > 0
         AND entry_date >= ? AND entry_date <= ?
       ORDER BY entry_date ASC, id ASC`,
    )
    .all(range.from, range.to) as JournalSpendRow[];
  const grouped = new Map<string, Record<JournalSpendRow["leg"], JournalSpendRow[]>>();
  for (const r of rows) {
    if (skipMonths.has(r.entry_date.slice(0, 7))) continue;
    if (!r.description || r.description === HOUSEHOLD_ADJUSTMENT_DESCRIPTION) continue;
    const key = `${r.entry_date}|${normalizePayee(r.description)}|${r.payment}`;
    const group = grouped.get(key) ?? { expense: [], household: [] };
    group[r.leg].push(r);
    grouped.set(key, group);
  }

  const out: SpendEvent[] = [];
  for (const group of grouped.values()) {
    // 按分ありは expense + household の対で元の 1 支出。同条件の支出が複数ある場合は
    // 各 leg の最大件数を残し、単純な Set による実取引の消失を避ける。
    const count = Math.max(group.expense.length, group.household.length);
    for (let i = 0; i < count; i++) {
      const r = group.expense[i] ?? group.household[i];
      if (!r) continue;
      out.push({
        id: `journal:${r.id}`,
        date: r.entry_date,
        payee: r.description,
        payee_norm: normalizePayee(r.description),
        amount: r.payment,
        kind: "transaction",
        method: "仕訳帳 (取込)",
        receipt_id: null,
        geo: null,
        items: null,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
