/**
 * 投資/優待アドバイザのオーケストレーション層。
 * 行動解析 → 銘柄マッピング → 株価/優待取得 → 統合提案 をまとめる。
 *
 * 外部アクセス (Claude / stooq) を伴う処理は明示呼び出し (mapTopPayees /
 * refreshQuotes / refreshPerks) に閉じ込め、 suggestions は DB キャッシュのみ読む。
 */

import type Database from "better-sqlite3";
import {
  analyzeBehavior,
  dataCoverage,
  resolveRange,
  type BehaviorEntry,
  type BehaviorFilter,
  type DataCoverage,
  type ResolvedRange,
} from "./behavior-analysis.js";
import type { SourceKind } from "../shared/types.js";
import { summarizeQuote, type StockClient } from "./stock-client.js";
import type { SecurityMapper } from "./security-mapper.js";
import type { PerkClient } from "./perk-client.js";
import { SecuritiesRepo } from "../db/securities-repo.js";
import { PayeeSecuritiesRepo, type PayeeSecurityRow } from "../db/payee-securities-repo.js";
import { StockQuotesRepo } from "../db/stock-quotes-repo.js";
import { ShareholderPerksRepo } from "../db/shareholder-perks-repo.js";

export interface InvestAdvisorDeps {
  db: Database.Database;
  securities: SecuritiesRepo;
  payeeSecurities: PayeeSecuritiesRepo;
  quotes: StockQuotesRepo;
  perks: ShareholderPerksRepo;
  mapper?: SecurityMapper;     // ANTHROPIC_API_KEY 無しなら undefined
  stock?: StockClient;         // 無効化時 undefined
  perkClient?: PerkClient;     // ANTHROPIC_API_KEY 無しなら undefined
}

export interface MapSummary {
  analyzed: number;     // 今回 Claude に問い合わせた payee 数
  listed: number;       // 上場該当ありになった数
  skipped: number;      // 既にマッピング済でスキップした数
}

export interface RefreshSummary {
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface Suggestion {
  /** この銘柄に紐付く店名 (表記揺れ・支店違いを束ねたもの) */
  payees: string[];
  visits: number;
  total_spend: number;
  ticker: string;
  company_name: string | null;
  market: string | null;
  relation: string;
  confidence: number;
  // 株価
  close: number | null;
  change_pct: number | null;
  period_days: number | null;
  as_of: string | null;
  // 優待
  has_perk: boolean;
  min_shares: number | null;
  perk_description: string | null;
  ex_rights_months: number[];
  perk_value_yen: number | null;
  perk_yield_pct: number | null;     // perk_value / (close*min_shares)
  required_investment: number | null; // close * min_shares
}

export class InvestAdvisor {
  constructor(private readonly deps: InvestAdvisorDeps) {}

  behavior(filter: BehaviorFilter = {}): BehaviorEntry[] {
    return analyzeBehavior(this.deps.db, filter);
  }

  /** データのある月 (既定窓の算出根拠)。 source で絞れる。 */
  coverage(source?: SourceKind | SourceKind[]): DataCoverage {
    return dataCoverage(this.deps.db, source);
  }

  /** filter から実際に集計に使う期間を解決する (UI の期間表示用)。 */
  resolvedRange(filter: BehaviorFilter = {}): ResolvedRange {
    return resolveRange(this.deps.db, filter);
  }

  /** 上位 payee のうち未マッピングを Claude で解析しキャッシュする。 */
  async mapTopPayees(filter: BehaviorFilter = {}): Promise<MapSummary> {
    if (!this.deps.mapper) throw new MapperUnavailable();
    const ranking = analyzeBehavior(this.deps.db, filter);
    const known = this.deps.payeeSecurities.mappedKeys();
    let analyzed = 0;
    let listed = 0;
    let skipped = 0;

    for (const entry of ranking) {
      if (known.has(entry.payee_norm)) {
        skipped++;
        continue;
      }
      const result = await this.deps.mapper.map(entry.payee_sample);
      analyzed++;
      if (result.is_listed && result.ticker) {
        this.deps.securities.upsert({
          ticker: result.ticker,
          name: result.company_name ?? entry.payee_sample,
          market: result.market,
        });
        this.deps.payeeSecurities.upsert({
          payee_norm: entry.payee_norm,
          payee_sample: entry.payee_sample,
          ticker: result.ticker,
          relation: result.relation,
          confidence: result.confidence,
          reason: result.reason,
          source: "claude",
        });
        listed++;
      } else {
        this.deps.payeeSecurities.upsert({
          payee_norm: entry.payee_norm,
          payee_sample: entry.payee_sample,
          ticker: null,
          relation: "none",
          confidence: result.confidence,
          reason: result.reason,
          source: "claude",
        });
      }
    }
    return { analyzed, listed, skipped };
  }

  /** マッピング済 (または指定) ticker の株価を取得・更新する。 */
  async refreshQuotes(opts: { tickers?: string[]; periodDays?: number } = {}): Promise<RefreshSummary> {
    if (!this.deps.stock) throw new StockUnavailable();
    const periodDays = opts.periodDays ?? 90;
    const tickers = opts.tickers ?? this.linkedTickers();
    let succeeded = 0;
    let failed = 0;
    for (const ticker of tickers) {
      try {
        const history = await this.deps.stock.history(ticker);
        const summary = history ? summarizeQuote(history, periodDays) : null;
        if (!summary) { failed++; continue; }
        this.deps.quotes.upsert({
          ticker,
          as_of: summary.as_of,
          close: summary.close,
          prev_close: summary.prev_close,
          change_pct: summary.change_pct,
          period_days: summary.period_days,
          bars: summary.bars,
        });
        succeeded++;
      } catch {
        failed++;
      }
    }
    return { attempted: tickers.length, succeeded, failed };
  }

  /** マッピング済 (または指定) ticker の優待を取得・更新する。 */
  async refreshPerks(opts: { tickers?: string[] } = {}): Promise<RefreshSummary> {
    if (!this.deps.perkClient) throw new PerkUnavailable();
    const tickers = opts.tickers ?? this.linkedTickers();
    let succeeded = 0;
    let failed = 0;
    for (const ticker of tickers) {
      try {
        const sec = this.deps.securities.find(ticker);
        const perk = await this.deps.perkClient.fetch(ticker, sec?.name ?? null);
        const yieldPct = computePerkYield(perk.perk_value_yen, perk.min_shares, this.latestClose(ticker));
        this.deps.perks.upsert({
          ticker,
          has_perk: perk.has_perk,
          min_shares: perk.min_shares,
          description: perk.description,
          ex_rights_months: perk.ex_rights_months,
          perk_value_yen: perk.perk_value_yen,
          yield_pct: yieldPct,
          notes: perk.notes,
          source: "claude",
        });
        succeeded++;
      } catch {
        failed++;
      }
    }
    return { attempted: tickers.length, succeeded, failed };
  }

  /**
   * 行動 × 銘柄 × 株価 × 優待 を結合した提案 (DB キャッシュのみ)。 上場リンク済のみ。
   * 同一 ticker に複数の店名 (支店違い・表記揺れ) が紐付く場合は 1 件に集約する。
   */
  suggestions(filter: BehaviorFilter = {}): Suggestion[] {
    const ranking = analyzeBehavior(this.deps.db, { ...filter, limit: filter.limit ?? 50 });

    // ticker 単位で行動指標を束ねる
    const byTicker = new Map<string, { payees: string[]; visits: number; total_spend: number; confidence: number; relation: string }>();
    for (const entry of ranking) {
      const link = this.deps.payeeSecurities.find(entry.payee_norm);
      if (!link?.ticker) continue;
      let g = byTicker.get(link.ticker);
      if (!g) {
        g = { payees: [], visits: 0, total_spend: 0, confidence: 0, relation: link.relation };
        byTicker.set(link.ticker, g);
      }
      g.payees.push(entry.payee_sample);
      g.visits += entry.visits;
      g.total_spend += entry.total_spend;
      g.confidence = Math.max(g.confidence, link.confidence);
    }

    const out: Suggestion[] = [];
    for (const [ticker, g] of byTicker) {
      const sec = this.deps.securities.find(ticker);
      const quote = this.deps.quotes.latest(ticker);
      const perk = this.deps.perks.find(ticker);
      const close = quote?.close ?? null;
      const minShares = perk?.min_shares ?? null;
      const requiredInvestment = close != null && minShares != null ? Math.round(close * minShares) : null;
      out.push({
        payees: g.payees,
        visits: g.visits,
        total_spend: g.total_spend,
        ticker,
        company_name: sec?.name ?? null,
        market: sec?.market ?? null,
        relation: g.relation,
        confidence: g.confidence,
        close,
        change_pct: quote?.change_pct ?? null,
        period_days: quote?.period_days ?? null,
        as_of: quote?.as_of ?? null,
        has_perk: perk ? perk.has_perk === 1 : false,
        min_shares: minShares,
        perk_description: perk?.description ?? null,
        ex_rights_months: perk?.ex_rights_months ? safeParseMonths(perk.ex_rights_months) : [],
        perk_value_yen: perk?.perk_value_yen ?? null,
        perk_yield_pct: computePerkYield(perk?.perk_value_yen ?? null, minShares, close),
        required_investment: requiredInvestment,
      });
    }
    return out.sort((a, b) => b.total_spend - a.total_spend);
  }

  private linkedTickers(): string[] {
    const links: PayeeSecurityRow[] = this.deps.payeeSecurities.listLinked();
    return [...new Set(links.map((l) => l.ticker!).filter(Boolean))];
  }

  private latestClose(ticker: string): number | null {
    return this.deps.quotes.latest(ticker)?.close ?? null;
  }
}

/** 優待利回り (%) = 優待価値 / (株価 × 必要株数) × 100。 算出不能なら null。 */
export function computePerkYield(
  perkValueYen: number | null,
  minShares: number | null,
  close: number | null,
): number | null {
  if (perkValueYen == null || minShares == null || close == null) return null;
  const investment = close * minShares;
  if (investment <= 0) return null;
  return Math.round((perkValueYen / investment) * 100 * 100) / 100;
}

function safeParseMonths(json: string): number[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((m) => typeof m === "number") : [];
  } catch {
    return [];
  }
}

export class MapperUnavailable extends Error {
  constructor() { super("security mapper unavailable (ANTHROPIC_API_KEY not set)"); }
}
export class StockUnavailable extends Error {
  constructor() { super("stock client unavailable"); }
}
export class PerkUnavailable extends Error {
  constructor() { super("perk client unavailable (ANTHROPIC_API_KEY not set)"); }
}
