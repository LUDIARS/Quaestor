/**
 * 配当株の公開データを Claude で取得する (株主優待の perk-client と同型)。
 *
 * ★ インサイダー方針 (spec/feature/portfolio-advisor.md):
 *   - 取得するのは「公開済 IR・有価証券報告書・適時開示・過去実績」由来の一般情報のみ。
 *   - 未公表の決算/業績/M&A 等の重要事実 (MNPI) は対象外。 推測で埋めない。
 *   - 出力は投資助言ではなく情報提示。 鮮度は fetched_at で管理し各社 IR 確認を促す。
 *   送信するのは証券コードと会社名のみ。
 */

import Anthropic from "@anthropic-ai/sdk";

export interface DividendData {
  dividend_yield_pct: number | null;        // 配当利回り %
  dps_annual: number | null;                // 年間 1 株配当 (円)
  payout_ratio_pct: number | null;          // 配当性向 %
  consecutive_increase_years: number | null; // 連続増配年数
  ex_rights_months: number[];               // 権利確定月 (1-12)
  stability_note: string | null;            // 減配リスク等の所見
  rationale: string | null;                 // 配当面の所見 (公開情報のみ)
}

export interface DividendClient {
  fetch(ticker: string, companyName: string | null): Promise<DividendData>;
}

const SYSTEM_PROMPT = `あなたは日本株の配当に詳しいアナリスト。 与えられた証券コードと会社名について、
配当に関する「公開情報・過去実績」を get_dividend ツールで構造化して返す。

厳守事項 (インサイダー対策):
- 参照してよいのは 公開済の IR 資料・有価証券報告書・適時開示・過去の配当実績 など一般に入手可能な情報のみ。
- 未公表の決算/業績予想の変更/増配減配の内部決定/M&A 等の重要事実 (MNPI) は絶対に扱わない・推測しない。
- 不確実・知識が古い可能性がある項目は null にし、 stability_note / rationale に「最新は各社 IR で要確認」と明記する。

各フィールド:
- dividend_yield_pct: 直近の配当利回り % (過去実績ベースの概算可)
- dps_annual: 年間 1 株あたり配当金 (円)
- payout_ratio_pct: 配当性向 %
- consecutive_increase_years: 連続増配年数 (不明なら null、 増配記録が無ければ 0)
- ex_rights_months: 権利確定月の配列 (例 [3, 9])。 不明なら空配列
- stability_note: 減配リスク・累進配当方針など、 配当の安定性に関する公開情報ベースの所見
- rationale: 配当面で着目される点 (公開情報のみ)。 投資助言ではなく情報提示として書く`;

const TOOL: Anthropic.Tool = {
  name: "get_dividend",
  description:
    "Return publicly-available dividend facts (yield, DPS, payout ratio, consecutive-increase years) for a Japanese securities code. Public/historical info only — never use MNPI.",
  input_schema: {
    type: "object",
    properties: {
      dividend_yield_pct: { type: ["number", "null"] },
      dps_annual: { type: ["number", "null"] },
      payout_ratio_pct: { type: ["number", "null"] },
      consecutive_increase_years: { type: ["integer", "null"] },
      ex_rights_months: { type: "array", items: { type: "integer" } },
      stability_note: { type: ["string", "null"] },
      rationale: { type: ["string", "null"] },
    },
    required: [
      "dividend_yield_pct",
      "dps_annual",
      "payout_ratio_pct",
      "consecutive_increase_years",
      "ex_rights_months",
      "stability_note",
      "rationale",
    ],
  },
};

export interface AnthropicDividendOptions {
  apiKey?: string;
  model?: string;
}

export class ClaudeDividendClient implements DividendClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicDividendOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-sonnet-4-6";
  }

  async fetch(ticker: string, companyName: string | null): Promise<DividendData> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 640,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "get_dividend" },
      messages: [
        {
          role: "user",
          content: `証券コード: ${ticker}${companyName ? ` (${companyName})` : ""}\nこの銘柄の配当の公開情報を get_dividend ツールで返してください。 未公表情報は扱わないこと。`,
        },
      ],
    });
    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tu) throw new Error("no tool_use in response");
    return normalizeDividend(tu.input as Record<string, unknown>);
  }
}

/** LLM 出力を型に正規化。 */
export function normalizeDividend(input: Record<string, unknown>): DividendData {
  return {
    dividend_yield_pct: numOrNull(input.dividend_yield_pct),
    dps_annual: numOrNull(input.dps_annual),
    payout_ratio_pct: numOrNull(input.payout_ratio_pct),
    consecutive_increase_years:
      typeof input.consecutive_increase_years === "number"
        ? Math.round(input.consecutive_increase_years)
        : null,
    ex_rights_months: Array.isArray(input.ex_rights_months)
      ? input.ex_rights_months
          .filter((m): m is number => typeof m === "number" && m >= 1 && m <= 12)
          .map((m) => Math.round(m))
      : [],
    stability_note: typeof input.stability_note === "string" ? input.stability_note : null,
    rationale: typeof input.rationale === "string" ? input.rationale : null,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
