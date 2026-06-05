/**
 * stock_quotes — 株価スナップショット (日足キャッシュ + 期間騰落率) の repo。
 */

import type Database from "better-sqlite3";

export interface QuoteBar {
  date: string;   // ISO yyyy-mm-dd
  close: number;
}

export interface StockQuoteRow {
  id: number;
  ticker: string;
  as_of: string;
  close: number | null;
  prev_close: number | null;
  change_pct: number | null;
  period_days: number | null;
  currency: string;
  bars: string | null;
  fetched_at: number;
}

export interface UpsertQuoteInput {
  ticker: string;
  as_of: string;
  close: number | null;
  prev_close?: number | null;
  change_pct?: number | null;
  period_days?: number | null;
  currency?: string;
  bars?: QuoteBar[] | null;
}

export class StockQuotesRepo {
  constructor(private readonly db: Database.Database) {}

  /** (ticker, as_of) を一意キーに upsert。 */
  upsert(input: UpsertQuoteInput): void {
    const now = nowSec();
    this.db
      .prepare(
        `INSERT INTO stock_quotes
           (ticker, as_of, close, prev_close, change_pct, period_days, currency, bars, fetched_at)
         VALUES (@ticker, @as_of, @close, @prev_close, @change_pct, @period_days, @currency, @bars, @fetched_at)
         ON CONFLICT(ticker, as_of) DO UPDATE SET
           close = excluded.close,
           prev_close = excluded.prev_close,
           change_pct = excluded.change_pct,
           period_days = excluded.period_days,
           currency = excluded.currency,
           bars = excluded.bars,
           fetched_at = excluded.fetched_at`,
      )
      .run({
        ticker: input.ticker,
        as_of: input.as_of,
        close: input.close,
        prev_close: input.prev_close ?? null,
        change_pct: input.change_pct ?? null,
        period_days: input.period_days ?? null,
        currency: input.currency ?? "JPY",
        bars: input.bars ? JSON.stringify(input.bars) : null,
        fetched_at: now,
      });
  }

  /** 最新 (as_of が最大) のスナップショット。 */
  latest(ticker: string): StockQuoteRow | undefined {
    return this.db
      .prepare(`SELECT * FROM stock_quotes WHERE ticker = ? ORDER BY as_of DESC LIMIT 1`)
      .get(ticker) as StockQuoteRow | undefined;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
