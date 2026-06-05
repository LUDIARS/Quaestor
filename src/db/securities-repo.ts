/**
 * securities — 銘柄マスタ (証券コード基準) の repo。
 */

import type Database from "better-sqlite3";

export interface SecurityRow {
  ticker: string;
  name: string;
  market: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertSecurityInput {
  ticker: string;
  name: string;
  market?: string | null;
  metadata?: Record<string, unknown> | null;
}

export class SecuritiesRepo {
  constructor(private readonly db: Database.Database) {}

  /** ticker を PK に upsert。 name/market は最新で上書きする。 */
  upsert(input: UpsertSecurityInput): void {
    const now = nowSec();
    this.db
      .prepare(
        `INSERT INTO securities (ticker, name, market, metadata, created_at, updated_at)
         VALUES (@ticker, @name, @market, @metadata, @now, @now)
         ON CONFLICT(ticker) DO UPDATE SET
           name = excluded.name,
           market = excluded.market,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: input.ticker,
        name: input.name,
        market: input.market ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      });
  }

  find(ticker: string): SecurityRow | undefined {
    return this.db.prepare(`SELECT * FROM securities WHERE ticker = ?`).get(ticker) as
      | SecurityRow
      | undefined;
  }

  list(): SecurityRow[] {
    return this.db.prepare(`SELECT * FROM securities ORDER BY ticker ASC`).all() as SecurityRow[];
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
