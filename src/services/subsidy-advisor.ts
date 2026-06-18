/**
 * 補助金サジェスト: 事業計画から検索キーワードを導出 → jGrants をクロール →
 * 計画との要件マッチングでランク付けして「使えそうな補助金」を提案する。
 *
 * crawler / matcher / keyword 導出は注入可能 (テストは実 HTTP / 実 LLM を叩かない)。
 */

import type { BusinessPlansRepo } from "../db/business-plans-repo.js";
import type { SubsidiesRepo } from "../db/subsidies-repo.js";
import { buildPlanSummaryText } from "./business-plan-service.js";
import type { SubsidyCrawler, CrawledSubsidy } from "./subsidy-crawler.js";
import type { SubsidyMatcher, Fit } from "./subsidy-matcher.js";
import { runClaudeCliJson } from "./claude-cli.js";

export interface SubsidySuggestion {
  candidate: CrawledSubsidy;
  fit: Fit;
  reasoning: string;
  /** 既に subsidies テーブルに取り込み済みか (jgrants_id 一致) */
  already_saved: boolean;
}

export interface SuggestDeps {
  plans: BusinessPlansRepo;
  repo: SubsidiesRepo;
  crawler: SubsidyCrawler;
  matcher: SubsidyMatcher;
  /** キーワード導出の注入 (省略時は claude CLI で導出) */
  deriveKeywords?: (planSummary: string) => Promise<string[]>;
  /** 1 キーワードあたりのクロール件数上限 */
  perKeywordLimit?: number;
}

export async function suggestSubsidies(
  deps: SuggestDeps,
  planId: string,
  keywords?: string[],
): Promise<{ keywords: string[]; suggestions: SubsidySuggestion[] }> {
  if (!deps.plans.find(planId)) throw new Error("plan not found");
  const planSummary = buildPlanSummaryText(deps.plans, planId);

  const kws = (keywords && keywords.length > 0)
    ? keywords
    : await (deps.deriveKeywords ?? defaultDeriveKeywords)(planSummary);

  // キーワードごとにクロール → external_id で dedup
  const byId = new Map<string, CrawledSubsidy>();
  for (const kw of kws) {
    const found = await deps.crawler.search(kw, { limit: deps.perKeywordLimit ?? 8 }).catch(() => []);
    for (const c of found) if (!byId.has(c.external_id)) byId.set(c.external_id, c);
  }
  const candidates = [...byId.values()];
  if (candidates.length === 0) return { keywords: kws, suggestions: [] };

  // マッチング (一時 index を subsidy_id に割り当て、 後で復元)
  const indexed = candidates.map((c, i) => ({ c, idx: i + 1 }));
  const matches = await deps.matcher.match({
    planSummary,
    subsidies: indexed.map(({ c, idx }) => ({ id: idx, name: c.name, target: c.target, requirements: c.requirements })),
  });
  const fitById = new Map(matches.map((m) => [m.subsidy_id, m]));

  const suggestions: SubsidySuggestion[] = indexed.map(({ c, idx }) => {
    const m = fitById.get(idx);
    return {
      candidate: c,
      fit: m?.fit ?? "low",
      reasoning: m?.reasoning ?? "",
      already_saved: !!deps.repo.findByExternalId(c.external_id),
    };
  });

  const rank: Record<Fit, number> = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => rank[a.fit] - rank[b.fit]);
  return { keywords: kws, suggestions };
}

const DERIVE_PROMPT = (summary: string): string =>
  `次の事業計画に合う補助金を日本の補助金検索システム (jGrants) で探すための検索キーワードを` +
  ` 2〜4 個、 日本語の短い語で挙げてください (例: 創業, 販路開拓, 設備投資, IT導入)。\n\n` +
  `# 事業計画\n${summary}\n\n` +
  `# 出力\nJSON 配列だけを出力: ["キーワード1", "キーワード2"]`;

/** claude CLI でキーワードを導出 (失敗時は汎用フォールバック) */
async function defaultDeriveKeywords(planSummary: string): Promise<string[]> {
  try {
    const v = await runClaudeCliJson(DERIVE_PROMPT(planSummary));
    const arr = Array.isArray(v) ? v : [];
    const kws = arr.filter((s): s is string => typeof s === "string" && s.trim().length >= 2).slice(0, 4);
    if (kws.length > 0) return kws;
  } catch { /* fall through */ }
  return ["創業", "販路開拓"];
}
