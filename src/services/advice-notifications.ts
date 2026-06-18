/**
 * 各アドバイザーの出力を Discord メッセージに整形するビルダー。
 * dedupKey は「内容が変わったか」判定用のハッシュ素材 (定期通知の重複抑止)。
 */

import type { DiscordMessage } from "./discord-notifier.js";
import type { SubsidySuggestion } from "./subsidy-advisor.js";
import type { Suggestion } from "./invest-advisor.js";
import type { DividendCandidateRow } from "../db/dividend-candidates-repo.js";

export interface BuiltAdvice {
  message: DiscordMessage;
  /** 内容の同一性判定キー (定期通知の dedup)。 空配列なら通知対象なし */
  dedupKey: string;
  /** 通知に値する項目が無ければ false */
  hasContent: boolean;
}

const COLOR = { subsidy: 0x4caf50, invest: 0x2196f3, dividend: 0xff9800 };
const FIT_JA: Record<string, string> = { high: "適合", medium: "条件次第", low: "対象外寄り" };
const yen = (n: number | null | undefined): string => (n == null ? "—" : `¥${n.toLocaleString("ja-JP")}`);
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 補助金サジェスト → 適合/条件次第 を上位 N 件 */
export function buildSubsidyAdvice(planName: string, suggestions: SubsidySuggestion[], topN = 5): BuiltAdvice {
  const picks = suggestions.filter((s) => s.fit === "high" || s.fit === "medium").slice(0, topN);
  if (picks.length === 0) {
    return { message: { content: "" }, dedupKey: "subsidy:none", hasContent: false };
  }
  const fields = picks.map((s) => ({
    name: `【${FIT_JA[s.fit] ?? s.fit}】${truncate(s.candidate.name, 200)}`,
    value: truncate(
      `${[s.candidate.max_amount != null ? `上限${yen(s.candidate.max_amount)}` : null,
         s.candidate.deadline ? `締切${s.candidate.deadline}` : null,
         s.candidate.url].filter(Boolean).join(" / ")}\n${s.reasoning}`,
      1000,
    ),
  }));
  return {
    message: {
      embeds: [{
        title: `📋 使えそうな補助金 (${planName})`,
        description: `事業計画に合いそうな募集中の補助金を ${picks.length} 件見つけました。`,
        color: COLOR.subsidy,
        fields,
        footer: { text: "Quaestor 補助金アドバイザー (jGrants)" },
      }],
    },
    dedupKey: `subsidy:${planName}:${picks.map((s) => `${s.candidate.external_id}=${s.fit}`).join(",")}`,
    hasContent: true,
  };
}

/** 投資/優待アドバイザ → 来店多い順 上位 N 件 */
export function buildInvestAdvice(suggestions: Suggestion[], topN = 5): BuiltAdvice {
  const picks = suggestions.slice(0, topN);
  if (picks.length === 0) {
    return { message: { content: "" }, dedupKey: "invest:none", hasContent: false };
  }
  const fields = picks.map((s) => {
    const parts = [
      s.ticker ? `証券コード ${s.ticker}` : null,
      s.close != null ? `株価${yen(s.close)}` : null,
      s.change_pct != null ? `${s.change_pct >= 0 ? "+" : ""}${s.change_pct.toFixed(1)}%` : null,
      s.has_perk && s.perk_yield_pct != null ? `優待利回り${s.perk_yield_pct.toFixed(1)}%` : null,
      `来店${s.visits}回 / 利用${yen(s.total_spend)}`,
    ].filter(Boolean);
    return {
      name: truncate(s.company_name ?? s.payees[0] ?? s.ticker, 200),
      value: truncate(parts.join(" / ") + (s.perk_description ? `\n優待: ${s.perk_description}` : ""), 1000),
    };
  });
  return {
    message: {
      embeds: [{
        title: "📈 投資/優待の提案",
        description: "よく使う店の運営企業から、 株主優待で得しそうな銘柄です。",
        color: COLOR.invest,
        fields,
        footer: { text: "Quaestor 投資/優待アドバイザー" },
      }],
    },
    dedupKey: `invest:${picks.map((s) => `${s.ticker}@${s.as_of ?? ""}`).join(",")}`,
    hasContent: true,
  };
}

/** 配当アドバイザ → 利回り高い順 上位 N 件 */
export function buildDividendAdvice(candidates: DividendCandidateRow[], topN = 5): BuiltAdvice {
  const picks = candidates.filter((c) => c.dividend_yield_pct != null).slice(0, topN);
  if (picks.length === 0) {
    return { message: { content: "" }, dedupKey: "dividend:none", hasContent: false };
  }
  const fields = picks.map((c) => {
    const parts = [
      c.dividend_yield_pct != null ? `配当利回り${c.dividend_yield_pct.toFixed(2)}%` : null,
      c.dps_annual != null ? `年間配当${yen(c.dps_annual)}` : null,
      c.payout_ratio_pct != null ? `配当性向${c.payout_ratio_pct.toFixed(0)}%` : null,
      c.consecutive_increase_years != null ? `${c.consecutive_increase_years}年連続増配` : null,
    ].filter(Boolean);
    return {
      name: `証券コード ${c.ticker}`,
      value: truncate(parts.join(" / ") + (c.rationale ? `\n${c.rationale}` : ""), 1000),
    };
  });
  return {
    message: {
      embeds: [{
        title: "💰 配当の提案",
        description: "保有・候補銘柄の配当利回り上位です。",
        color: COLOR.dividend,
        fields,
        footer: { text: "Quaestor 配当アドバイザー" },
      }],
    },
    dedupKey: `dividend:${picks.map((c) => `${c.ticker}=${c.dividend_yield_pct}`).join(",")}`,
    hasContent: true,
  };
}
