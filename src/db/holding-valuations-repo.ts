/**
 * holding_valuations — 保有商品の時価スナップショット repo。
 * 手動入力 (投信の基準価額 / 保険の解約返戻金) と stooq 自動取得 (個別株/ETF) の両方を保持する。
 */

import type Database from "better-sqlite3";

export type ValuationSource = "manual" | "stooq" | "import";

export interface ValuationRow {
  id: number;
  holding_id: string;
  as_of: string;
  market_value: number;
  unit_price: number | null;
  units: number | null;
  fx_rate: number | null;
  source: ValuationSource;
  note: string | null;
  created_at: number;
}

export interface UpsertValuationInput {
  holding_id: string;
  as_of: string;
  market_value: number;
  unit_price?: number | null;
  units?: number | null;
  fx_rate?: number | null;
  source?: ValuationSource;
  note?: string | null;
}

export class HoldingValuationsRepo {
  constructor(private readonly db: Database.Database) {}

  /** 同 holding × as_of は最新値で上書き。 */
  upsert(input: UpsertValuationInput): ValuationRow {
    this.db
      .prepare(
        `INSERT INTO holding_valuations
           (holding_id, as_of, market_value, unit_price, units, fx_rate, source, note, created_at)
         VALUES (@holding_id, @as_of, @market_value, @unit_price, @units, @fx_rate, @source, @note, @now)
         ON CONFLICT(holding_id, as_of) DO UPDATE SET
           market_value = excluded.market_value,
           unit_price   = excluded.unit_price,
           units        = excluded.units,
           fx_rate      = excluded.fx_rate,
           source       = excluded.source,
           note         = excluded.note`,
      )
      .run({
        holding_id: input.holding_id,
        as_of: input.as_of,
        market_value: input.market_value,
        unit_price: input.unit_price ?? null,
        units: input.units ?? null,
        fx_rate: input.fx_rate ?? null,
        source: input.source ?? "manual",
        note: input.note ?? null,
        now: nowSec(),
      });
    return this.db
      .prepare(`SELECT * FROM holding_valuations WHERE holding_id = ? AND as_of = ?`)
      .get(input.holding_id, input.as_of) as ValuationRow;
  }

  /** 直近 (as_of 最大) の評価。 無ければ undefined。 */
  latest(holdingId: string): ValuationRow | undefined {
    return this.db
      .prepare(`SELECT * FROM holding_valuations WHERE holding_id = ? ORDER BY as_of DESC, id DESC LIMIT 1`)
      .get(holdingId) as ValuationRow | undefined;
  }

  list(holdingId: string): ValuationRow[] {
    return this.db
      .prepare(`SELECT * FROM holding_valuations WHERE holding_id = ? ORDER BY as_of ASC`)
      .all(holdingId) as ValuationRow[];
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
