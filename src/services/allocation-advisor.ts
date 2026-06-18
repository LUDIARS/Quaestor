/**
 * 資産配分アドバイザー: 現在のポートフォリオから「目標配分・投資幅・具体的な金融資産」を
 * 論拠付きで提案する。 提案は Claude (claude-cli、 サブスク auth、 API key 不要) で生成。
 *
 * スナップショット構築は純関数 (テスト可)。 LLM 呼び出しは runner 注入でテスト。
 * 送信するのは資産クラス別の集計・保有名・税制枠のみ (口座番号等は送らない)。
 */

import type { HoldingSummary, PortfolioTotals } from "./portfolio-service.js";
import { runClaudeCliJson, type ClaudeCliOptions } from "./claude-cli.js";

const KIND_LABEL: Record<string, string> = {
  fund: "投資信託", stock: "個別株", etf: "ETF", insurance: "保険", other: "その他",
};
const WRAPPER_LABEL: Record<string, string> = {
  nisa_tsumitate: "NISА積立", nisa_growth: "NISA成長投資枠", ideco: "iDeCo", taxable: "課税口座", insurance: "保険",
};

export interface AssetSlice {
  key: string;
  label: string;
  value: number;
  pct: number;     // totalValue に対する %
  count: number;
}

export interface PortfolioSnapshot {
  asOf: string;
  totalValue: number;          // 評価額 (無い holding は invested) の合計
  totalInvested: number;
  monthlyContribution: number;
  unrealizedPl: number;
  byKind: AssetSlice[];
  byTaxWrapper: AssetSlice[];
  holdings: { name: string; kind: string; tax_wrapper: string | null; value: number; monthly: number | null }[];
}

/** summary() の結果から配分スナップショットを構築する (純関数) */
export function buildPortfolioSnapshot(
  asOf: string,
  data: { holdings: HoldingSummary[]; totals: PortfolioTotals },
): PortfolioSnapshot {
  const valueOf = (s: HoldingSummary): number => s.latest_valuation?.market_value ?? s.ret.invested;
  const totalValue = data.holdings.reduce((a, s) => a + valueOf(s), 0);

  const slice = (groupKey: (s: HoldingSummary) => string, labels: Record<string, string>): AssetSlice[] => {
    const map = new Map<string, { value: number; count: number }>();
    for (const s of data.holdings) {
      const k = groupKey(s);
      const cur = map.get(k) ?? { value: 0, count: 0 };
      cur.value += valueOf(s);
      cur.count += 1;
      map.set(k, cur);
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, label: labels[key] ?? key, value: v.value, count: v.count, pct: totalValue > 0 ? (v.value / totalValue) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  };

  return {
    asOf,
    totalValue,
    totalInvested: data.totals.invested,
    monthlyContribution: data.totals.monthly_contribution,
    unrealizedPl: data.totals.unrealized_pl,
    byKind: slice((s) => s.holding.kind, KIND_LABEL),
    byTaxWrapper: slice((s) => s.holding.tax_wrapper ?? "taxable", WRAPPER_LABEL),
    holdings: data.holdings.map((s) => ({
      name: s.holding.name,
      kind: KIND_LABEL[s.holding.kind] ?? s.holding.kind,
      tax_wrapper: s.holding.tax_wrapper ? (WRAPPER_LABEL[s.holding.tax_wrapper] ?? s.holding.tax_wrapper) : null,
      value: valueOf(s),
      monthly: s.holding.monthly_contribution,
    })),
  };
}

export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface AdviceProfile {
  risk?: RiskProfile;
  goal?: string;            // 目標 (例: 20年で2000万、 教育資金)
  monthlyBudget?: number;   // 毎月投資に回せる額 (円)
}

export interface AllocationLine {
  asset_class: string;      // 例 国内株 / 先進国株 / 債券 / 現金
  current_pct: number;
  target_pct: number;
  action: "increase" | "decrease" | "hold";
  rationale: string;
}

export interface AssetIdea {
  name: string;             // 商品カテゴリ or 具体名 (例 全世界株式インデックス投信)
  kind: string;             // 投資信託 / ETF / 個別株 / 債券 等
  tax_wrapper: string | null; // 推奨する税制枠
  rationale: string;
}

export interface AllocationAdvice {
  summary: string;
  risk_profile: RiskProfile;
  target_allocation: AllocationLine[];
  investment_capacity: { suggested_monthly: number | null; note: string }; // 投資幅
  asset_ideas: AssetIdea[];
}

export interface AllocationAdvisor {
  recommend(snapshot: PortfolioSnapshot, profile?: AdviceProfile): Promise<AllocationAdvice>;
}

export interface ClaudeAllocationAdvisorOptions extends ClaudeCliOptions {
  runner?: (prompt: string) => Promise<unknown>;
}

export class ClaudeAllocationAdvisor implements AllocationAdvisor {
  constructor(private readonly opts: ClaudeAllocationAdvisorOptions = {}) {}

  async recommend(snapshot: PortfolioSnapshot, profile: AdviceProfile = {}): Promise<AllocationAdvice> {
    const prompt = buildAllocationPrompt(snapshot, profile);
    const value = this.opts.runner ? await this.opts.runner(prompt) : await runClaudeCliJson(prompt, this.opts);
    return normalizeAdvice(value, profile.risk ?? "balanced");
  }
}

const yen = (n: number): string => `${Math.round(n).toLocaleString("ja-JP")}円`;

export function buildAllocationPrompt(snapshot: PortfolioSnapshot, profile: AdviceProfile): string {
  const kindLines = snapshot.byKind.map((s) => `  - ${s.label}: ${yen(s.value)} (${s.pct.toFixed(1)}%)`).join("\n");
  const wrapperLines = snapshot.byTaxWrapper.map((s) => `  - ${s.label}: ${yen(s.value)} (${s.pct.toFixed(1)}%)`).join("\n");
  const holdLines = snapshot.holdings
    .map((h) => `  - ${h.name} [${h.kind}${h.tax_wrapper ? "/" + h.tax_wrapper : ""}] ${yen(h.value)}${h.monthly ? ` 月${yen(h.monthly)}` : ""}`)
    .join("\n");

  return (
    `あなたは日本の個人投資家向けのファイナンシャルアドバイザー。 現在のポートフォリオを踏まえ、\n` +
    `目標とする資産配分、 追加で投資に回せる幅 (投資幅)、 具体的な金融資産の候補を、 すべて論拠付きで提案する。\n\n` +
    `前提・ルール:\n` +
    `- 日本の税制 (NISA つみたて/成長投資枠、 iDeCo、 課税口座) を踏まえる。 NISA/iDeCo の非課税枠の活用を優先的に検討する\n` +
    `- リスク許容度: ${profile.risk ?? "balanced"} (conservative=低リスク重視 / balanced=中庸 / aggressive=成長重視)\n` +
    (profile.goal ? `- 目標: ${profile.goal}\n` : "") +
    (profile.monthlyBudget ? `- 毎月投資に回せる額の上限目安: ${yen(profile.monthlyBudget)}\n` : "") +
    `- 特定銘柄の断定的な売買推奨ではなく、 資産クラス配分と一般的な商品カテゴリ (インデックス投信等) を中心に。 個別名は例示に留め論拠を必ず添える\n` +
    `- current_pct はスナップショットの現状配分を反映する\n\n` +
    `# 現在のポートフォリオ (asOf ${snapshot.asOf})\n` +
    `総評価額: ${yen(snapshot.totalValue)} / 投資元本: ${yen(snapshot.totalInvested)} / 含み損益: ${yen(snapshot.unrealizedPl)} / 計画積立: 月${yen(snapshot.monthlyContribution)}\n` +
    `資産クラス別:\n${kindLines || "  (なし)"}\n` +
    `税制枠別:\n${wrapperLines || "  (なし)"}\n` +
    `保有:\n${holdLines || "  (なし)"}\n\n` +
    `# 出力形式 (厳守)\n説明や前置きを書かず、 以下の JSON オブジェクトだけを出力すること。\n` +
    "```\n" +
    `{\n` +
    `  "summary": "<総評・方針 2-4文>",\n` +
    `  "target_allocation": [ { "asset_class": "<資産クラス>", "current_pct": <数値>, "target_pct": <数値>, "action": "increase|decrease|hold", "rationale": "<論拠>" } ],\n` +
    `  "investment_capacity": { "suggested_monthly": <円 or null>, "note": "<投資幅の論拠>" },\n` +
    `  "asset_ideas": [ { "name": "<商品カテゴリ/例>", "kind": "<投信/ETF/債券等>", "tax_wrapper": "<NISA等 or null>", "rationale": "<論拠>" } ]\n` +
    `}\n` +
    "```"
  );
}

const clampPct = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);

/** LLM 出力を型に正規化 */
export function normalizeAdvice(value: unknown, fallbackRisk: RiskProfile): AllocationAdvice {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const lines = Array.isArray(o.target_allocation) ? o.target_allocation : [];
  const ideas = Array.isArray(o.asset_ideas) ? o.asset_ideas : [];
  const cap = (o.investment_capacity && typeof o.investment_capacity === "object" ? o.investment_capacity : {}) as Record<string, unknown>;
  return {
    summary: typeof o.summary === "string" ? o.summary : "",
    risk_profile: fallbackRisk,
    target_allocation: lines.map((l) => normalizeLine(l as Record<string, unknown>)),
    investment_capacity: {
      suggested_monthly: typeof cap.suggested_monthly === "number" ? Math.round(cap.suggested_monthly) : null,
      note: typeof cap.note === "string" ? cap.note : "",
    },
    asset_ideas: ideas.map((i) => normalizeIdea(i as Record<string, unknown>)),
  };
}

function normalizeLine(l: Record<string, unknown>): AllocationLine {
  const action = l.action === "increase" || l.action === "decrease" || l.action === "hold" ? l.action : "hold";
  return {
    asset_class: typeof l.asset_class === "string" ? l.asset_class : "",
    current_pct: clampPct(l.current_pct),
    target_pct: clampPct(l.target_pct),
    action,
    rationale: typeof l.rationale === "string" ? l.rationale : "",
  };
}

function normalizeIdea(i: Record<string, unknown>): AssetIdea {
  return {
    name: typeof i.name === "string" ? i.name : "",
    kind: typeof i.kind === "string" ? i.kind : "",
    tax_wrapper: typeof i.tax_wrapper === "string" ? i.tax_wrapper : null,
    rationale: typeof i.rationale === "string" ? i.rationale : "",
  };
}
