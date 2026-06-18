/**
 * holding_dividends — 受取分配金/配当の実績 repo。
 * 再投資しない (reinvested=0) 分は XIRR の正の cashflow として効く。
 */

import type Database from "better-sqlite3";

export interface DividendRow {
  id: number;
  holding_id: string;
  pay_date: string;
  amount: number;
  per_share: number | null;
  reinvested: number; // 0 | 1
  note: string | null;
  created_at: number;
}

export interface AddDividendInput {
  holding_id: string;
  pay_date: string;
  amount: number;
  per_share?: number | null;
  reinvested?: boolean;
  note?: string | null;
}

export class HoldingDividendsRepo {
  constructor(private readonly db: Database.Database) {}

  add(input: AddDividendInput): DividendRow {
    const info = this.db
      .prepare(
        `INSERT INTO holding_dividends (holding_id, pay_date, amount, per_share, reinvested, note, created_at)
         VALUES (@holding_id, @pay_date, @amount, @per_share, @reinvested, @note, @now)`,
      )
      .run({
        holding_id: input.holding_id,
        pay_date: input.pay_date,
        amount: input.amount,
        per_share: input.per_share ?? null,
        reinvested: input.reinvested ? 1 : 0,
        note: input.note ?? null,
        now: nowSec(),
      });
    return this.db
      .prepare(`SELECT * FROM holding_dividends WHERE id = ?`)
      .get(info.lastInsertRowid) as DividendRow;
  }

  list(holdingId: string): DividendRow[] {
    return this.db
      .prepare(`SELECT * FROM holding_dividends WHERE holding_id = ? ORDER BY pay_date ASC, id ASC`)
      .all(holdingId) as DividendRow[];
  }

  remove(id: number): boolean {
    const info = this.db.prepare(`DELETE FROM holding_dividends WHERE id = ?`).run(id);
    return info.changes > 0;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
