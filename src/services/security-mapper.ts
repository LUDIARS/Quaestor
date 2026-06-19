/**
 * 店名 → 上場企業 → 証券コードのマッピングを Claude CLI で推定する。
 *
 * 設計方針:
 *  - DI 可能な interface 化 (テストは fake を渡す)
 *  - 既定 model は会社知識の精度が要るため CLI (Sonnet 相当)
 *  - 送信するのは店名文字列のみ。金額・日付・個人情報は渡さない
 */

import { runClaudeCliJson, type ClaudeCliOptions } from "./claude-cli.js";
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
日本の証券コード (4 桁) を特定するアナリスト。与えられた店名 (レシート/クレカ明細由来で
表記揺れあり) について、国内上場企業を 1 社だけ同定する。

判定ルール:
- relation: operator=店の運営会社そのもの / brand=ブランドを保有する上場企業 /
  parent=店の運営会社の親会社が上場 / none=上場該当なし(非上場・個人店・公共料金等)
- ticker は東京証券取引所等の国内 4 桁コードのみ。海外上場・非上場なら ticker=null, is_listed=false
- 確信が持てない時は confidence を下げ、不明なら is_listed=false, relation=none とする
- 推測で適当なコードを返さない。コードに自信が無ければ null
- reason に同定根拠を日本語で簡潔に書く`;

export interface ClaudeMapperOptions extends ClaudeCliOptions {
  runner?: (prompt: string) => Promise<unknown>;
}

export class ClaudeSecurityMapper implements SecurityMapper {
  constructor(private readonly opts: ClaudeMapperOptions = {}) {}

  async map(payeeSample: string): Promise<SecurityMapResult> {
    const prompt = buildMapperPrompt(payeeSample);
    const json = this.opts.runner
      ? await this.opts.runner(prompt)
      : await runClaudeCliJson(prompt, this.opts);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("no JSON in response");
    }
    return normalizeResult(json as Record<string, unknown>);
  }
}

function buildMapperPrompt(payeeSample: string): string {
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `店名: ${payeeSample}\n` +
    `この店を運営する国内上場企業と証券コードを回答してください。\n\n` +
    `# 出力形式 (厳守)\n` +
    `説明や前置きは一切書かず、以下のスキーマの JSON オブジェクトだけを出力すること。\n` +
    `\`\`\`\n` +
    `{\n` +
    `  "is_listed": <boolean>,\n` +
    `  "ticker": <"NNNN"|null>,\n` +
    `  "company_name": <string|null>,\n` +
    `  "market": <string|null>,\n` +
    `  "relation": <"operator"|"brand"|"parent"|"none">,\n` +
    `  "confidence": <0..1>,\n` +
    `  "reason": <string>\n` +
    `}\n` +
    `\`\`\``
  );
}

/** LLM 出力を型に正規化。ticker は 4 桁数字のみ採用する。 */
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
