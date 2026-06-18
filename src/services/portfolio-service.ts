/**
 * 積立ポートフォリオ / 配当アドバイザのオーケストレーション層。
 *
 * 保有商品 (holdings) + 拠出 (contributions) + 時価 (valuations) + 配当 (dividends) を束ね、
 * 利回り (portfolio-return) / 見通し (portfolio-projection) / 配当株サジェスト (dividend-client) を提供する。
 *
 * 外部アクセス (stooq / Claude) を伴うのは refreshValuations / suggestDividends の明示操作のみ。
 * summary / projection は DB キャッシュのみで完結する。
 */

import type { HoldingsRepo, HoldingRow } from "../db/holdings-repo.js";
import type { ContributionsRepo } from "../db/contributions-repo.js";
import type { HoldingValuationsRepo, ValuationRow } from "../db/holding-valuations-repo.js";
import type { HoldingDividendsRepo } from "../db/holding-dividends-repo.js";
import type { DividendCandidatesRepo, DividendCandidateRow } from "../db/dividend-candidates-repo.js";
import type { SecuritiesRepo } from "../db/securities-repo.js";
import type { StockQuotesRepo } from "../db/stock-quotes-repo.js";
import { summarizeQuote, type StockClient } from "./stock-client.js";
import type { DividendClient } from "./dividend-client.js";
import { computeHoldingReturn, type ReturnResult } from "./portfolio-return.js";
import {
  projectScenarios,
  DEFAULT_SCENARIO_RATES,
  type ScenarioProjection,
  type ScenarioRates,
} from "./portfolio-projection.js";

export interface PortfolioDeps {
  holdings: HoldingsRepo;
  contributions: ContributionsRepo;
  valuations: HoldingValuationsRepo;
  dividends: HoldingDividendsRepo;
  dividendCandidates: DividendCandidatesRepo;
  securities: SecuritiesRepo;
  quotes: StockQuotesRepo;
  stock?: StockClient;            // 無効化時 undefined
  dividendClient?: DividendClient; // ANTHROPIC_API_KEY 無しなら undefined
}

export interface HoldingSummary {
  holding: HoldingRow;
  latest_valuation: ValuationRow | null;
  ret: ReturnResult;
}

export interface PortfolioTotals {
  count: number;
  invested: number;
  market_value: number;          // 評価額が取れた holding のみ合算
  valued_invested: number;       // market_value を持つ holding の invested (利回り分母)
  unrealized_pl: number;
  dividends_received: number;
  simple_return_pct: number | null;
  planned_to_date: number;
  actual_to_date: number;
  variance: number;
  monthly_contribution: number;  // active holding の計画積立合計 (円/月)
}

export interface RefreshSummary {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export class PortfolioService {
  constructor(private readonly deps: PortfolioDeps) {}

  /** 1 holding の利回り (DB キャッシュのみ)。 */
  holdingSummary(holding: HoldingRow, asOf: string): HoldingSummary {
    const contributions = this.deps.contributions.list(holding.id).map((c) => ({
      date: c.date,
      amount: c.amount,
      kind: c.kind,
    }));
    const dividends = this.deps.dividends.list(holding.id).map((d) => ({
      pay_date: d.pay_date,
      amount: d.amount,
      reinvested: d.reinvested === 1,
    }));
    const latest = this.deps.valuations.latest(holding.id) ?? null;
    const ret = computeHoldingReturn({
      contributions,
      dividends,
      marketValue: latest?.market_value ?? null,
      valuationAsOf: latest?.as_of ?? null,
      asOf,
      monthlyContribution: holding.monthly_contribution,
      startedAt: holding.started_at,
    });
    return { holding, latest_valuation: latest, ret };
  }

  /** 全 holding の利回り + ポートフォリオ合計。 */
  summary(asOf: string, opts: { status?: "active" | "paused" | "closed" } = {}): {
    holdings: HoldingSummary[];
    totals: PortfolioTotals;
  } {
    const rows = this.deps.holdings.list(opts.status ? { status: opts.status } : {});
    const holdings = rows.map((h) => this.holdingSummary(h, asOf));
    return { holdings, totals: aggregateTotals(holdings) };
  }

  /**
   * 将来見通し。 holdingId 指定でその商品、 null でポートフォリオ全体を投影する。
   * monthlyContribution は holding の計画値、 currentValue は直近評価額を使う。
   */
  projection(
    holdingId: string | null,
    opts: { years?: number; rates?: ScenarioRates; asOf: string },
  ): ScenarioProjection {
    const months = Math.round((opts.years ?? 20) * 12);
    if (holdingId) {
      const h = this.deps.holdings.find(holdingId);
      if (!h) throw new HoldingNotFound(holdingId);
      const s = this.holdingSummary(h, opts.asOf);
      return projectScenarios({
        currentValue: s.latest_valuation?.market_value ?? s.ret.invested,
        monthlyContribution: h.monthly_contribution ?? 0,
        months,
        rates: opts.rates,
        targetAmount: h.target_amount,
      });
    }
    // ポートフォリオ全体
    const { holdings, totals } = this.summary(opts.asOf, { status: "active" });
    const currentValue = holdings.reduce(
      (acc, s) => acc + (s.latest_valuation?.market_value ?? s.ret.invested),
      0,
    );
    const targetAmount = holdings.reduce((acc, s) => acc + (s.holding.target_amount ?? 0), 0) || null;
    return projectScenarios({
      currentValue,
      monthlyContribution: totals.monthly_contribution,
      months,
      rates: opts.rates,
      targetAmount,
    });
  }

  /**
   * 個別株/ETF (ticker あり) の評価額を stooq から更新する。
   * 保有口数 = 直近 valuation.units ?? 拠出の units 合計。 評価額 = 終値 × 口数。
   * 投信/保険は stooq 非対応のため skip。
   */
  async refreshValuations(opts: { holdingIds?: string[]; asOf: string }): Promise<RefreshSummary> {
    if (!this.deps.stock) throw new StockUnavailable();
    const rows = opts.holdingIds
      ? opts.holdingIds.map((id) => this.deps.holdings.find(id)).filter((h): h is HoldingRow => !!h)
      : this.deps.holdings.list({ status: "active" });
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let attempted = 0;
    for (const h of rows) {
      if ((h.kind !== "stock" && h.kind !== "etf") || !h.ticker) {
        skipped++;
        continue;
      }
      const units = this.heldUnits(h.id);
      if (units == null || units <= 0) {
        skipped++;
        continue;
      }
      attempted++;
      try {
        const history = await this.deps.stock.history(h.ticker);
        const quote = history ? summarizeQuote(history, 90) : null;
        if (!quote) {
          failed++;
          continue;
        }
        // securities マスタにも記録 (配当サジェストの FK 先)
        this.deps.securities.upsert({ ticker: h.ticker, name: h.name });
        this.deps.quotes.upsert({
          ticker: h.ticker,
          as_of: quote.as_of,
          close: quote.close,
          prev_close: quote.prev_close,
          change_pct: quote.change_pct,
          period_days: quote.period_days,
          bars: quote.bars,
        });
        this.deps.valuations.upsert({
          holding_id: h.id,
          as_of: quote.as_of,
          market_value: Math.round(quote.close * units),
          unit_price: quote.close,
          units,
          source: "stooq",
        });
        succeeded++;
      } catch {
        failed++;
      }
    }
    return { attempted, succeeded, skipped, failed };
  }

  /**
   * 配当株サジェスト。 指定 ticker (無指定なら保有銘柄の ticker) について
   * 公開情報ベースの配当データを Claude で取得し dividend_candidates にキャッシュする。
   * 株価も併せて取得し、 yield を株価×実績から補正できるようにする。
   */
  async suggestDividends(opts: { tickers?: string[] }): Promise<RefreshSummary> {
    if (!this.deps.dividendClient) throw new DividendUnavailable();
    const tickers = opts.tickers && opts.tickers.length > 0 ? opts.tickers : this.heldTickers();
    let succeeded = 0;
    let failed = 0;
    for (const ticker of tickers) {
      try {
        const sec = this.deps.securities.find(ticker);
        const data = await this.deps.dividendClient.fetch(ticker, sec?.name ?? null);
        // securities が無ければ最低限のマスタを作る (FK 先確保)
        if (!sec) this.deps.securities.upsert({ ticker, name: ticker });
        this.deps.dividendCandidates.upsert({
          ticker,
          dividend_yield_pct: data.dividend_yield_pct,
          dps_annual: data.dps_annual,
          payout_ratio_pct: data.payout_ratio_pct,
          consecutive_increase_years: data.consecutive_increase_years,
          ex_rights_months: data.ex_rights_months,
          stability_note: data.stability_note,
          rationale: data.rationale,
          source: "claude",
        });
        succeeded++;
      } catch {
        failed++;
      }
    }
    return { attempted: tickers.length, succeeded, skipped: 0, failed };
  }

  /** 配当サジェスト一覧 (株価を結合)。 */
  dividendCandidates(): (DividendCandidateRow & { close: number | null; company_name: string | null })[] {
    return this.deps.dividendCandidates.list().map((c) => {
      const sec = this.deps.securities.find(c.ticker);
      const quote = this.deps.quotes.latest(c.ticker);
      return { ...c, close: quote?.close ?? null, company_name: sec?.name ?? null };
    });
  }

  /** 保有口数 (株数): 直近 valuation.units を優先、 無ければ拠出の units 合計。 */
  private heldUnits(holdingId: string): number | null {
    const latest = this.deps.valuations.latest(holdingId);
    if (latest?.units != null) return latest.units;
    const contribs = this.deps.contributions.list(holdingId, "actual");
    const sumUnits = contribs.reduce((acc, c) => acc + (c.units ?? 0), 0);
    return sumUnits > 0 ? sumUnits : null;
  }

  private heldTickers(): string[] {
    const tickers = this.deps.holdings
      .list()
      .map((h) => h.ticker)
      .filter((t): t is string => !!t);
    return [...new Set(tickers)];
  }
}

/** holding サマリ群をポートフォリオ合計に畳む (純関数, テスト容易)。 */
export function aggregateTotals(holdings: HoldingSummary[]): PortfolioTotals {
  let invested = 0;
  let marketValue = 0;
  let valuedInvested = 0;
  let unrealized = 0;
  let dividendsReceived = 0;
  let plannedToDate = 0;
  let actualToDate = 0;
  let monthly = 0;
  for (const s of holdings) {
    invested += s.ret.invested;
    dividendsReceived += s.ret.dividends_received;
    actualToDate += s.ret.actual_to_date;
    plannedToDate += s.ret.planned_to_date ?? 0;
    if (s.holding.status === "active") monthly += s.holding.monthly_contribution ?? 0;
    if (s.ret.market_value != null) {
      marketValue += s.ret.market_value;
      valuedInvested += s.ret.invested;
      unrealized += s.ret.unrealized_pl ?? 0;
    }
  }
  const simpleReturnPct =
    valuedInvested > 0 ? Math.round(((unrealized + dividendsReceived) / valuedInvested) * 10000) / 100 : null;
  return {
    count: holdings.length,
    invested,
    market_value: marketValue,
    valued_invested: valuedInvested,
    unrealized_pl: unrealized,
    dividends_received: dividendsReceived,
    simple_return_pct: simpleReturnPct,
    planned_to_date: plannedToDate,
    actual_to_date: actualToDate,
    variance: actualToDate - plannedToDate,
    monthly_contribution: monthly,
  };
}

export { DEFAULT_SCENARIO_RATES };

export class HoldingNotFound extends Error {
  constructor(id: string) {
    super(`holding not found: ${id}`);
  }
}
export class StockUnavailable extends Error {
  constructor() {
    super("stock client unavailable");
  }
}
export class DividendUnavailable extends Error {
  constructor() {
    super("dividend client unavailable (ANTHROPIC_API_KEY not set)");
  }
}
