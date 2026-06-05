/**
 * shareholder_perks — 株主優待の repo。 1 ticker = 1 行。
 */

import type Database from "better-sqlite3";

export interface PerkRow {
  id: number;
  ticker: string;
  has_perk: number;            // 0 / 1
  min_shares: number | null;
  description: string | null;
  ex_rights_months: string | null;   // JSON: [3,9]
  perk_value_yen: number | null;
  yield_pct: number | null;
  notes: string | null;
  source: "claude" | "manual";
  fetched_at: number;
  updated_at: number;
}

export interface UpsertPerkInput {
  ticker: string;
  has_perk: boolean;
  min_shares?: number | null;
  description?: string | null;
  ex_rights_months?: number[] | null;
  perk_value_yen?: number | null;
  yield_pct?: number | null;
  notes?: string | null;
  source?: "claude" | "manual";
}

export class ShareholderPerksRepo {
  constructor(private readonly db: Database.Database) {}

  /** ticker を一意キーに upsert。 */
  upsert(input: UpsertPerkInput): void {
    const now = nowSec();
    this.db
      .prepare(
        `INSERT INTO shareholder_perks
           (ticker, has_perk, min_shares, description, ex_rights_months,
            perk_value_yen, yield_pct, notes, source, fetched_at, updated_at)
         VALUES (@ticker, @has_perk, @min_shares, @description, @ex_rights_months,
                 @perk_value_yen, @yield_pct, @notes, @source, @now, @now)
         ON CONFLICT(ticker) DO UPDATE SET
           has_perk = excluded.has_perk,
           min_shares = excluded.min_shares,
           description = excluded.description,
           ex_rights_months = excluded.ex_rights_months,
           perk_value_yen = excluded.perk_value_yen,
           yield_pct = excluded.yield_pct,
           notes = excluded.notes,
           source = excluded.source,
           fetched_at = excluded.fetched_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: input.ticker,
        has_perk: input.has_perk ? 1 : 0,
        min_shares: input.min_shares ?? null,
        description: input.description ?? null,
        ex_rights_months: input.ex_rights_months ? JSON.stringify(input.ex_rights_months) : null,
        perk_value_yen: input.perk_value_yen ?? null,
        yield_pct: input.yield_pct ?? null,
        notes: input.notes ?? null,
        source: input.source ?? "claude",
        now,
      });
  }

  find(ticker: string): PerkRow | undefined {
    return this.db
      .prepare(`SELECT * FROM shareholder_perks WHERE ticker = ?`)
      .get(ticker) as PerkRow | undefined;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
