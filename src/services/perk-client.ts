/**
 * 株主優待情報を Claude CLI で取得する。
 *
 * 株主優待は公式 API が存在しないため LLM 知識ベース。鮮度は fetched_at で管理し、
 * notes に「最新の優待内容は各社 IR で要確認」前提を持たせる運用とする。
 * 送信するのは証券コードと会社名のみ。
 */

import { runClaudeCliJson, type ClaudeCliOptions } from "./claude-cli.js";

export interface PerkResult {
  has_perk: boolean;
  min_shares: number | null;       // 必要株数
  description: string | null;      // 優待内容
  ex_rights_months: number[];      // 権利確定月 (1-12)
  perk_value_yen: number | null;   // 優待価値 (円, 概算)
  notes: string | null;
}

export interface PerkClient {
  fetch(ticker: string, companyName: string | null): Promise<PerkResult>;
}

const SYSTEM_PROMPT = `あなたは日本株の株主優待に詳しいアナリスト。与えられた証券コードと会社名について、
株主優待制度を構造化して返す。

ルール:
- has_perk: 株主優待制度があれば true。無ければ false で他は null/空
- min_shares: 優待を受け取れる最小株数 (通常 100 株単位)
- description: 優待内容を日本語で簡潔に (例「自社店舗で使える 2,000 円分の優待券」)
- ex_rights_months: 権利確定月の配列 (例 [2, 8])。不明なら空配列
- perk_value_yen: 最小株数で得られる優待の概算金額 (円)。換算しにくければ null
- 制度は改定されるため、notes に「最新は各社 IR で要確認」と添える
- 知識に無い・不確実な場合は has_perk=false にせず、分かる範囲を埋め notes に不確実性を書く`;

export interface ClaudePerkOptions extends ClaudeCliOptions {
  runner?: (prompt: string) => Promise<unknown>;
}

export class ClaudePerkClient implements PerkClient {
  constructor(private readonly opts: ClaudePerkOptions = {}) {}

  async fetch(ticker: string, companyName: string | null): Promise<PerkResult> {
    const prompt = buildPerkPrompt(ticker, companyName);
    const json = this.opts.runner
      ? await this.opts.runner(prompt)
      : await runClaudeCliJson(prompt, this.opts);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("no JSON in response");
    }
    return normalizePerk(json as Record<string, unknown>);
  }
}

function buildPerkPrompt(ticker: string, companyName: string | null): string {
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `証券コード: ${ticker}${companyName ? ` (${companyName})` : ""}\n` +
    `この銘柄の株主優待を回答してください。\n\n` +
    `# 出力形式 (厳守)\n` +
    `説明や前置きは一切書かず、以下のスキーマの JSON オブジェクトだけを出力すること。\n` +
    `\`\`\`\n` +
    `{\n` +
    `  "has_perk": <boolean>,\n` +
    `  "min_shares": <number|null>,\n` +
    `  "description": <string|null>,\n` +
    `  "ex_rights_months": [<number>, ...],\n` +
    `  "perk_value_yen": <number|null>,\n` +
    `  "notes": <string|null>\n` +
    `}\n` +
    `\`\`\``
  );
}

/** LLM 出力を型に正規化。 */
export function normalizePerk(input: Record<string, unknown>): PerkResult {
  const hasPerk = input.has_perk === true;
  return {
    has_perk: hasPerk,
    min_shares: typeof input.min_shares === "number" ? Math.round(input.min_shares) : null,
    description: typeof input.description === "string" ? input.description : null,
    ex_rights_months: Array.isArray(input.ex_rights_months)
      ? input.ex_rights_months
          .filter((m): m is number => typeof m === "number" && m >= 1 && m <= 12)
          .map((m) => Math.round(m))
      : [],
    perk_value_yen: typeof input.perk_value_yen === "number" ? Math.round(input.perk_value_yen) : null,
    notes: typeof input.notes === "string" ? input.notes : null,
  };
}
