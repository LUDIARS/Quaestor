/**
 * 店名 → 上場企業 → 証券コードのマッピングを Claude で推定する。
 *
 * 設計方針 (ocr-client.ts と同じ流儀):
 *  - tool_use + tool_choice で構造化を強制
 *  - DI 可能な interface 化 (テストは fake を渡す)
 *  - 既定 model は会社知識の精度が要るため Sonnet (OCR の Haiku より上)
 *  - 送信するのは店名文字列のみ。 金額・日付・個人情報は渡さない
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SecurityRelation } from "../db/payee-securities-repo.js";

export interface SecurityMapResult {
  is_listed: boolean;
  ticker: string | null;        // 4 桁証券コード (国内上場のみ)
  company_name: string | null;
  market: string | null;        // 例 "東証プライム"
  relation: SecurityRelation;   // operator / brand / parent / none
  confidence: number;           // 0..1
  reason: string;
}

export interface SecurityMapper {
  map(payeeSample: string): Promise<SecurityMapResult>;
}

const SYSTEM_PROMPT = `あなたは日本の小売・サービスの店名から、その店を「運営する上場企業」と
日本の証券コード (4 桁) を特定するアナリスト。 与えられた店名 (レシート/クレカ明細由来で
表記揺れあり) について、 国内上場企業を 1 社だけ同定する。

判定ルール:
- relation: operator=店の運営会社そのもの / brand=ブランドを保有する上場企業 /
  parent=店の運営会社の親会社が上場 / none=上場該当なし(非上場・個人店・公共料金等)
- ticker は東京証券取引所等の国内 4 桁コードのみ。 海外上場・非上場なら ticker=null, is_listed=false
- 確信が持てない時は confidence を下げ、 不明なら is_listed=false, relation=none とする
- 推測で適当なコードを返さない。 コードに自信が無ければ null
- reason に同定根拠を日本語で簡潔に書く`;

const TOOL: Anthropic.Tool = {
  name: "map_security",
  description: "Map a Japanese store/payee name to its listed operating company and securities code.",
  input_schema: {
    type: "object",
    properties: {
      is_listed: { type: "boolean", description: "true if a domestic-listed company operates/owns this store" },
      ticker: { type: ["string", "null"], description: "4-digit Japanese securities code, else null" },
      company_name: { type: ["string", "null"], description: "company name in Japanese, else null" },
      market: { type: ["string", "null"], description: "listing market e.g. 東証プライム, else null" },
      relation: { type: "string", enum: ["operator", "brand", "parent", "none"] },
      confidence: { type: "number", description: "0..1 confidence of the mapping" },
      reason: { type: "string", description: "rationale in Japanese" },
    },
    required: ["is_listed", "ticker", "company_name", "market", "relation", "confidence", "reason"],
  },
};

export interface AnthropicMapperOptions {
  apiKey?: string;
  model?: string;
}

export class ClaudeSecurityMapper implements SecurityMapper {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicMapperOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-sonnet-4-6";
  }

  async map(payeeSample: string): Promise<SecurityMapResult> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "map_security" },
      messages: [
        {
          role: "user",
          content: `店名: ${payeeSample}\nこの店を運営する国内上場企業と証券コードを map_security ツールで返してください。`,
        },
      ],
    });

    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tu) throw new Error("no tool_use in response");
    return normalizeResult(tu.input as Record<string, unknown>);
  }
}

/** LLM 出力を型に正規化。 ticker は 4 桁数字のみ採用する。 */
export function normalizeResult(input: Record<string, unknown>): SecurityMapResult {
  const rawTicker = typeof input.ticker === "string" ? input.ticker.trim() : null;
  const ticker = rawTicker && /^\d{4}$/.test(rawTicker) ? rawTicker : null;
  const relation = ["operator", "brand", "parent", "none"].includes(input.relation as string)
    ? (input.relation as SecurityRelation)
    : "none";
  const isListed = input.is_listed === true && ticker !== null;
  return {
    is_listed: isListed,
    ticker: isListed ? ticker : null,
    company_name: typeof input.company_name === "string" ? input.company_name : null,
    market: typeof input.market === "string" ? input.market : null,
    relation: isListed ? relation : "none",
    confidence: typeof input.confidence === "number" ? clamp01(input.confidence) : 0,
    reason: typeof input.reason === "string" ? input.reason : "",
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
