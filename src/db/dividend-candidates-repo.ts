/**
 * dividend_candidates — 配当株サジェストのキャッシュ repo。
 *
 * 公開・過去実績データのみ (配当利回り / 配当性向 / 連続増配年数 等)。
 * 未公表情報 (MNPI) は扱わない (spec/feature/portfolio-advisor.md §インサイダー方針)。
 * 1 ticker = 1 行。 securities(ticker) を FK 参照するため事前に securities へ upsert すること。
 */

import type Database from "better-sqlite3";

export interface DividendCandidateRow {
  id: number;
  ticker: string;
  dividend_yield_pct: number | null;
  dps_annual: number | null;
  payout_ratio_pct: number | null;
  consecutive_increase_years: number | null;
  ex_rights_months: string | null; // JSON [3,9]
  stability_note: string | null;
  rationale: string | null;
  source: "claude" | "manual";
  fetched_at: number;
  updated_at: number;
}

export interface UpsertDividendCandidateInput {
  ticker: string;
  dividend_yield_pct?: number | null;
  dps_annual?: number | null;
  payout_ratio_pct?: number | null;
  consecutive_increase_years?: number | null;
  ex_rights_months?: number[];
  stability_note?: string | null;
  rationale?: string | null;
  source?: "claude" | "manual";
}

export class DividendCandidatesRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: UpsertDividendCandidateInput): DividendCandidateRow {
    const now = nowSec();
    this.db
      .prepare(
        `INSERT INTO dividend_candidates
           (ticker, dividend_yield_pct, dps_annual, payout_ratio_pct, consecutive_increase_years,
            ex_rights_months, stability_note, rationale, source, fetched_at, updated_at)
         VALUES
           (@ticker, @dividend_yield_pct, @dps_annual, @payout_ratio_pct, @consecutive_increase_years,
            @ex_rights_months, @stability_note, @rationale, @source, @now, @now)
         ON CONFLICT(ticker) DO UPDATE SET
           dividend_yield_pct          = excluded.dividend_yield_pct,
           dps_annual                  = excluded.dps_annual,
           payout_ratio_pct            = excluded.payout_ratio_pct,
           consecutive_increase_years  = excluded.consecutive_increase_years,
           ex_rights_months            = excluded.ex_rights_months,
           stability_note              = excluded.stability_note,
           rationale                   = excluded.rationale,
           source                      = excluded.source,
           updated_at                  = excluded.updated_at`,
      )
      .run({
        ticker: input.ticker,
        dividend_yield_pct: input.dividend_yield_pct ?? null,
        dps_annual: input.dps_annual ?? null,
        payout_ratio_pct: input.payout_ratio_pct ?? null,
        consecutive_increase_years: input.consecutive_increase_years ?? null,
        ex_rights_months: input.ex_rights_months ? JSON.stringify(input.ex_rights_months) : null,
        stability_note: input.stability_note ?? null,
        rationale: input.rationale ?? null,
        source: input.source ?? "claude",
        now,
      });
    return this.find(input.ticker)!;
  }

  find(ticker: string): DividendCandidateRow | undefined {
    return this.db
      .prepare(`SELECT * FROM dividend_candidates WHERE ticker = ?`)
      .get(ticker) as DividendCandidateRow | undefined;
  }

  list(): DividendCandidateRow[] {
    return this.db
      .prepare(`SELECT * FROM dividend_candidates ORDER BY dividend_yield_pct DESC NULLS LAST`)
      .all() as DividendCandidateRow[];
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
