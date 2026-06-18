/**
 * 補助金データの自動収集。 jGrants (補助金電子申請システム) の公開 API から
 * 募集中の補助金を取得し、 Quaestor の subsidy 形式に正規化する。
 *
 * 公式 API: https://api.jgrants-portal.go.jp/exp/v1/public/subsidies
 *   - 一覧:  GET ?keyword=&sort=created_date&order=DESC&acceptance=1 (acceptance=1 は募集中のみ)
 *   - 詳細:  GET /id/{id} → subsidy_rate(テキスト) / detail / target 等の richer フィールド
 *
 * StooqStockClient と同じく fetchImpl を DI してテストする (実 HTTP を叩かない)。
 */

import type { CreateSubsidyInput } from "../db/subsidies-repo.js";

const DEFAULT_BASE = "https://api.jgrants-portal.go.jp/exp/v1/public";

export interface CrawledSubsidy extends CreateSubsidyInput {
  /** jGrants の一意 id (dedup 用、 metadata.jgrants_id にも入る) */
  external_id: string;
}

export interface SubsidyCrawler {
  /** keyword で募集中の補助金を検索して正規化済み候補を返す */
  search(keyword: string, opts?: { limit?: number }): Promise<CrawledSubsidy[]>;
}

interface JGrantsListItem {
  id: string;
  name: string;
  title: string;
  subsidy_max_limit: number | null;
  target_area_search: string | null;
  target_number_of_employees: string | null;
  acceptance_end_datetime: string | null;
  institution_name: string | null;
}

interface JGrantsDetail extends JGrantsListItem {
  subsidy_rate: string | null;
  detail: string | null;
  use_purpose: string | null;
  industry: string | null;
  subsidy_catch_phrase: string | null;
  front_subsidy_detail_page_url: string | null;
}

export interface JGrantsCrawlerOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 詳細 API で enrich する件数の上限 (要件・補助率取得)。 既定 10 */
  enrichLimit?: number;
}

export class JGrantsCrawler implements SubsidyCrawler {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly enrichLimit: number;

  constructor(opts: JGrantsCrawlerOptions = {}) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.enrichLimit = opts.enrichLimit ?? 10;
  }

  async search(keyword: string, opts: { limit?: number } = {}): Promise<CrawledSubsidy[]> {
    if (keyword.trim().length < 2) return []; // jGrants は keyword 2 文字以上必須
    const limit = opts.limit ?? this.enrichLimit;
    const url =
      `${this.base}/subsidies?keyword=${encodeURIComponent(keyword)}` +
      `&sort=acceptance_end_datetime&order=ASC&acceptance=1`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`jGrants list ${res.status}`);
    const json = (await res.json()) as { result?: JGrantsListItem[] };
    const items = (json.result ?? []).slice(0, limit);

    const out: CrawledSubsidy[] = [];
    for (const item of items) {
      const detail = await this.fetchDetail(item.id).catch(() => null);
      out.push(normalize(item, detail));
    }
    return out;
  }

  private async fetchDetail(id: string): Promise<JGrantsDetail | null> {
    const res = await this.fetchImpl(`${this.base}/subsidies/id/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: JGrantsDetail[] };
    return json.result?.[0] ?? null;
  }
}

/** jGrants の一覧 + 詳細 を Quaestor の subsidy 形式へ正規化する */
export function normalize(item: JGrantsListItem, detail: JGrantsDetail | null): CrawledSubsidy {
  const title = item.title;
  const kind = /融資|貸付/.test(title) ? "loan" : /助成/.test(title) ? "grant" : "subsidy";
  const targetParts = [item.target_area_search, item.target_number_of_employees, detail?.use_purpose]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  const summary = detail?.subsidy_catch_phrase ?? truncate(detail?.detail, 300) ?? null;
  return {
    external_id: item.id,
    name: title,
    agency: item.institution_name,
    kind,
    url: detail?.front_subsidy_detail_page_url ?? `https://www.jgrants-portal.go.jp/subsidy/${item.id}`,
    summary,
    target: targetParts.length ? targetParts.join(" / ") : null,
    requirements: truncate(detail?.detail, 2000) ?? null,
    max_amount: item.subsidy_max_limit && item.subsidy_max_limit > 0 ? item.subsidy_max_limit : null,
    subsidy_rate: parseRate(detail?.subsidy_rate),
    deadline: dateOf(item.acceptance_end_datetime),
    status: "open",
    metadata: {
      source: "jgrants",
      jgrants_id: item.id,
      s_code: item.name,
      subsidy_rate_text: detail?.subsidy_rate ?? null,
      industry: detail?.industry ?? null,
      area: item.target_area_search ?? null,
    },
  };
}

/** "2/3以内" のような補助率テキストから先頭の分数を 0..1 に。 取れなければ null */
export function parseRate(text: string | null | undefined): number | null {
  if (!text) return null;
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (frac) {
    const n = Number(frac[1]); const d = Number(frac[2]);
    if (d > 0 && n <= d) return Math.round((n / d) * 1000) / 1000;
  }
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct) { const v = Number(pct[1]) / 100; if (v <= 1) return v; }
  return null;
}

function dateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1]! : null;
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
