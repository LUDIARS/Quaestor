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

// ---------------------------------------------------------------------------
// ミラサポ plus クローラ
// ---------------------------------------------------------------------------

export interface MirasapoPlusOptions {
  /** テスト用差し替え。既定 https://www.mirasapo-plus.go.jp */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface MirasapoItem {
  id: string;
  name: string;
  ministerialDepartment: string | null;
  deadline: string | null;
  summary: string | null;
  target: string | null;
  maxAmount: number | null;
  url: string | null;
}

/** ミラサポ plus (METI 中小企業向け補助金ナビ) から補助金を取得する。
 *
 *  公開 API は仕様非公開のため HTML レスポンスをパースする。
 *  URL 構造: GET /subsidy/result?keyword={kw}&page=1
 *  サイト改修で壊れる場合は baseUrl / parseHtml を調整する。
 */
export class MirasapoPlusCrawler implements SubsidyCrawler {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MirasapoPlusOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://www.mirasapo-plus.go.jp").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(keyword: string, opts: { limit?: number } = {}): Promise<CrawledSubsidy[]> {
    if (keyword.trim().length < 2) return [];
    const limit = opts.limit ?? 10;
    const url = `${this.baseUrl}/subsidy/result?keyword=${encodeURIComponent(keyword)}&page=1`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": "Mozilla/5.0 Quaestor/1.0", "Accept": "text/html" },
      });
    } catch { return []; }
    if (!res.ok) return [];
    const html = await res.text();
    return parseMirasapoHtml(html, this.baseUrl).slice(0, limit);
  }
}

/** ミラサポ plus の検索結果 HTML から補助金リストを抽出する。 */
export function parseMirasapoHtml(html: string, baseUrl: string): CrawledSubsidy[] {
  const out: CrawledSubsidy[] = [];
  // 補助金カード: <article> or <li class="...subsidy..."> or <div class="...item...">
  // タイトルと詳細リンクを持つブロックを正規表現で抽出する
  const cardRe = /<(?:article|li)[^>]*>([\s\S]*?)<\/(?:article|li)>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && out.length < 50) {
    const block = m[1]!;
    const item = extractMirasapoCard(block, baseUrl);
    if (item) out.push(normalizeMirasapo(item));
  }
  return out;
}

function extractMirasapoCard(block: string, baseUrl: string): MirasapoItem | null {
  // href から id と URL
  const hrefM = /href="([^"]*\/subsidy\/[^"?#]+(?:\/(\d+)[^"]*)?)"/.exec(block);
  if (!hrefM) return null;
  const rawHref = hrefM[1]!;
  const detailUrl = rawHref.startsWith("http") ? rawHref : `${baseUrl}${rawHref}`;
  // id: URL末尾の数字 or UUIDっぽい文字列
  const idM = /\/(\d{5,}|[a-f0-9]{8}-[a-f0-9-]{27})\/?(?:\?|$)/.exec(rawHref);
  const id = idM ? idM[1]! : rawHref.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-32);

  // タイトル: <h2>/<h3>/<a> の最初のテキスト
  const titleM = /<(?:h[23]|a)[^>]*>([\s\S]*?)<\/(?:h[23]|a)>/.exec(block);
  const name = titleM ? stripTags(titleM[1]!).trim() : null;
  if (!name || name.length < 4) return null;

  // 省庁・機関名
  const agencyM = /(?:省庁|機関|実施機関|補助機関|主務官庁)[^<]*?[：:](.*?)(?:<|$)/.exec(block)
    ?? /class="[^"]*(?:agency|institution|ministry)[^"]*"[^>]*>([\s\S]*?)<\//.exec(block);
  const agency = agencyM ? stripTags(agencyM[1]!).trim() : null;

  // 締切日: yyyy/mm/dd または yyyy-mm-dd
  const dlM = /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/.exec(block);
  const deadline = dlM ? `${dlM[1]}-${dlM[2]}-${dlM[3]}` : null;

  // 上限金額
  const amtM = /(?:上限|最大|補助上限)[^\d]*(\d[\d,]+)万?円/.exec(block);
  const maxAmount = amtM ? parseJpAmount(amtM[1]!, block) : null;

  // 概要
  const summaryM = /class="[^"]*(?:summary|description|overview|catch)[^"]*"[^>]*>([\s\S]*?)<\//.exec(block);
  const summary = summaryM ? stripTags(summaryM[1]!).slice(0, 300).trim() : null;

  return { id, name, ministerialDepartment: agency, deadline, summary, target: null, maxAmount, url: detailUrl };
}

function normalizeMirasapo(item: MirasapoItem): CrawledSubsidy {
  const kind = /融資|貸付/.test(item.name) ? "loan" : /助成/.test(item.name) ? "grant" : "subsidy";
  return {
    external_id: item.id,
    name: item.name,
    agency: item.ministerialDepartment,
    kind,
    url: item.url,
    summary: item.summary,
    target: item.target,
    requirements: null,
    max_amount: item.maxAmount,
    subsidy_rate: null,
    deadline: item.deadline,
    status: "open",
    metadata: { source: "mirasapo", external_id: item.id },
  };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}

function parseJpAmount(numStr: string, block: string): number | null {
  const n = Number(numStr.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  // "万円" が後続するかどうか判定
  return /万円/.test(block) ? n * 10000 : n;
}

// ---------------------------------------------------------------------------
// CompositeCrawler — 複数ソースを並列実行して外部 ID で dedup
// ---------------------------------------------------------------------------

export class CompositeCrawler implements SubsidyCrawler {
  constructor(private readonly sources: SubsidyCrawler[]) {}

  async search(keyword: string, opts: { limit?: number } = {}): Promise<CrawledSubsidy[]> {
    const limit = opts.limit ?? 20;
    const perSource = Math.ceil(limit / this.sources.length);
    const results = await Promise.allSettled(
      this.sources.map((s) => s.search(keyword, { limit: perSource })),
    );
    const seen = new Set<string>();
    const out: CrawledSubsidy[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value) {
        if (!seen.has(item.external_id)) {
          seen.add(item.external_id);
          out.push(item);
        }
      }
    }
    return out.slice(0, limit);
  }
}
