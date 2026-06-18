/**
 * contributions — 拠出 (積立) の計画/実績 repo。
 * plan-variance (計画 vs 実績) と XIRR (実拠出 cashflow) の入力源。
 */

import type Database from "better-sqlite3";

export type ContributionKind = "planned" | "actual";

export interface ContributionRow {
  id: number;
  holding_id: string;
  date: string;
  amount: number;
  kind: ContributionKind;
  units: number | null;
  unit_price: number | null;
  note: string | null;
  created_at: number;
}

export interface AddContributionInput {
  holding_id: string;
  date: string;
  amount: number;
  kind?: ContributionKind;
  units?: number | null;
  unit_price?: number | null;
  note?: string | null;
}

export class ContributionsRepo {
  constructor(private readonly db: Database.Database) {}

  add(input: AddContributionInput): ContributionRow {
    const info = this.db
      .prepare(
        `INSERT INTO contributions (holding_id, date, amount, kind, units, unit_price, note, created_at)
         VALUES (@holding_id, @date, @amount, @kind, @units, @unit_price, @note, @now)`,
      )
      .run({
        holding_id: input.holding_id,
        date: input.date,
        amount: input.amount,
        kind: input.kind ?? "actual",
        units: input.units ?? null,
        unit_price: input.unit_price ?? null,
        note: input.note ?? null,
        now: nowSec(),
      });
    return this.db
      .prepare(`SELECT * FROM contributions WHERE id = ?`)
      .get(info.lastInsertRowid) as ContributionRow;
  }

  list(holdingId: string, kind?: ContributionKind): ContributionRow[] {
    if (kind) {
      return this.db
        .prepare(`SELECT * FROM contributions WHERE holding_id = ? AND kind = ? ORDER BY date ASC, id ASC`)
        .all(holdingId, kind) as ContributionRow[];
    }
    return this.db
      .prepare(`SELECT * FROM contributions WHERE holding_id = ? ORDER BY date ASC, id ASC`)
      .all(holdingId) as ContributionRow[];
  }

  remove(id: number): boolean {
    const info = this.db.prepare(`DELETE FROM contributions WHERE id = ?`).run(id);
    return info.changes > 0;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
