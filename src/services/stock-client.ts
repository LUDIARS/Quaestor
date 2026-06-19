/**
 * 株価取得クライアント。
 *
 * 既定実装は Yahoo Finance v8 chart API (無料・登録不要、東証株は ".T" suffix)。
 * stooq は 2026-06 より JS PoW anti-bot ゲートが掛かり CSV fetch が失敗するため非既定。
 * J-Quants 等へ差し替えられるよう StockClient interface で抽象化している。
 */

import type { QuoteBar } from "../db/stock-quotes-repo.js";

export interface PriceHistory {
  ticker: string;
  as_of: string;          // 最新足の日付 ISO yyyy-mm-dd
  bars: QuoteBar[];       // 日付昇順
}

export interface StockClient {
  /** ticker (証券コード, 例 "8267") の日足履歴を取得。 取得不可なら null。 */
  history(ticker: string): Promise<PriceHistory | null>;
}

export interface QuoteSummary {
  as_of: string;
  close: number;
  prev_close: number;
  change_pct: number;
  period_days: number;
  bars: QuoteBar[];        // 期間内の足 (sparkline 用)
}

/**
 * 日足履歴を期間騰落率付きのスナップショットに集約する (純関数, テスト容易)。
 * period_days はカレンダー日。 終点の最新足と、 期間始点に最も近い足を比較する。
 */
export function summarizeQuote(history: PriceHistory, periodDays: number): QuoteSummary | null {
  const bars = history.bars.filter((b) => Number.isFinite(b.close));
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1]!;
  const cutoff = isoMinusDays(last.date, periodDays);
  const windowBars = bars.filter((b) => b.date >= cutoff);
  const first = (windowBars[0] ?? bars[0])!;
  const prevClose = first.close;
  const changePct = prevClose !== 0 ? ((last.close - prevClose) / prevClose) * 100 : 0;
  return {
    as_of: last.date,
    close: last.close,
    prev_close: prevClose,
    change_pct: Math.round(changePct * 100) / 100,
    period_days: periodDays,
    bars: windowBars.length > 0 ? windowBars : bars.slice(-2),
  };
}

// ---------------------------------------------------------------------------
// Yahoo Finance v8 chart API (既定の株価取得源)
// ---------------------------------------------------------------------------

export interface YahooFinanceOptions {
  /** テスト用差し替え。既定 https://query1.finance.yahoo.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface YFChartResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: { quote: Array<{ close: (number | null)[] }> };
    }> | null;
    error: unknown;
  };
}

export class YahooFinanceStockClient implements StockClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: YahooFinanceOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.YAHOO_FINANCE_BASE_URL ?? "https://query1.finance.yahoo.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async history(ticker: string): Promise<PriceHistory | null> {
    const symbol = encodeURIComponent(`${ticker}.T`);
    const url = `${this.baseUrl}/v8/finance/chart/${symbol}?interval=1d&range=6mo`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": "Mozilla/5.0 Quaestor/1.0", "Accept": "application/json" },
      });
    } catch { return null; }
    if (!res.ok) return null;
    let json: YFChartResponse;
    try { json = (await res.json()) as YFChartResponse; } catch { return null; }
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars: QuoteBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const close = closes[i];
      if (!ts || close == null || !Number.isFinite(close)) continue;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      bars.push({ date, close });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length === 0) return null;
    return { ticker, as_of: bars[bars.length - 1]!.date, bars };
  }
}

// ---------------------------------------------------------------------------

/** ISO yyyy-mm-dd から days 日前の ISO 文字列。 */
function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface StooqOptions {
  /** ベース URL (テストで差し替え可)。 既定 https://stooq.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class StooqStockClient implements StockClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StooqOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.STOOQ_BASE_URL ?? "https://stooq.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async history(ticker: string): Promise<PriceHistory | null> {
    const symbol = `${ticker.toLowerCase()}.jp`;
    const url = `${this.baseUrl}/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
    const res = await this.fetchImpl(url);
    if (!res.ok) return null;
    const text = await res.text();
    const bars = parseStooqCsv(text);
    if (bars.length === 0) return null;
    return { ticker, as_of: bars[bars.length - 1]!.date, bars };
  }
}

/**
 * stooq 日足 CSV をパースする。 形式:
 *   Date,Open,High,Low,Close,Volume
 *   2024-01-04,3500,3520,3480,3510,123456
 * 未知シンボルは本文が "No data" 等になるので空配列を返す。
 */
export function parseStooqCsv(csv: string): QuoteBar[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0]!.toLowerCase().split(",");
  const dateIdx = header.indexOf("date");
  const closeIdx = header.indexOf("close");
  if (dateIdx === -1 || closeIdx === -1) return [];
  const bars: QuoteBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const date = cols[dateIdx];
    const close = Number(cols[closeIdx]);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close)) continue;
    bars.push({ date, close });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}
