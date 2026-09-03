/**
 * 「スクショ」「コピペテキスト」 から transactions / receipts を抽出するスマート import。
 *
 * Anthropic vision (画像) または text completion (テキスト) で構造化抽出。
 * 抽出結果は normal な ImportedTransaction[] に変換して既存 transactions / receipts
 * テーブルに insert する。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ImportedTransaction, SourceKind } from "../shared/types.js";
import { statementRowSourceId } from "./statement-rows.js";

export interface SmartImportOptions {
  apiKey?: string;
  model?: string;
}

export interface SmartImportResult {
  source: SourceKind;
  brand: string;
  account: string;
  rows: ImportedTransaction[];
  warnings: string[];
}

const SCREENSHOT_TOOL: Anthropic.Tool = {
  name: "extract_statement",
  description: "Extract transaction rows from a credit card / bank statement screenshot.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["credit-card", "bank", "amazon", "receipt"] },
      account: { type: "string", description: "guessed account label (e.g. 'SMBC NL', 'UFJ普通')" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "yyyy-mm-dd (no year shown → guess from screenshot)" },
            payee: { type: "string" },
            amount_out: { type: ["integer", "null"] },
            amount_in: { type: ["integer", "null"] },
            fx_amount: { type: ["number", "null"] },
            fx_currency: { type: ["string", "null"] },
            description: { type: "string" },
          },
          required: ["date", "description"],
        },
      },
    },
    required: ["kind", "account", "rows"],
  },
};

const SCREENSHOT_SYSTEM = `あなたは日本のクレカ明細 / 銀行明細 / Amazon 注文履歴 のスクショから取引行を構造化抽出する OCR アシスタント。
以下を守って抽出する:
- 日付は yyyy-mm-dd (年が見えない場合はスクショ内の年表示や「今年」を推測)
- 金額は税込総額、 整数 (円)。 ハイフン / 全角は除く
- 入金 amount_in と出金 amount_out のどちらか片方のみ入れる (両方は不可)
- 外貨決済の元金額 / 通貨が併記されてる場合は fx_amount / fx_currency に
- 一覧の見出し行 / 合計行 / 残高行は対象外
- payee は短く (店舗名または取引先)、 description は摘要そのまま (補足含む)
- 不確実な行は出さない (false positive より miss を選ぶ)
`;

export class SmartImporter {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: SmartImportOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-haiku-4-5-20251001";
  }

  async fromScreenshot(image: Buffer, mime: "image/jpeg" | "image/png", account?: string): Promise<SmartImportResult> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: [{ type: "text", text: SCREENSHOT_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [SCREENSHOT_TOOL],
      tool_choice: { type: "tool", name: "extract_statement" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: image.toString("base64") } },
            { type: "text", text: "extract_statement ツールでこのスクショから取引行を抽出してください。" },
          ],
        },
      ],
    });
    return parseToolUse(res, account);
  }

  async fromText(text: string, account?: string): Promise<SmartImportResult> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: [{ type: "text", text: SCREENSHOT_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [SCREENSHOT_TOOL],
      tool_choice: { type: "tool", name: "extract_statement" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `以下はクレカ明細 / 銀行明細などからコピペされたテキスト。 extract_statement で取引行を抽出して。\n\n---\n${text.slice(0, 30000)}` },
          ],
        },
      ],
    });
    return parseToolUse(res, account);
  }
}

function parseToolUse(res: Anthropic.Message, accountOverride?: string): SmartImportResult {
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!tu) throw new Error("no tool_use in response");
  const input = tu.input as {
    kind?: SourceKind;
    account?: string;
    rows?: Array<{
      date: string;
      payee?: string | null;
      amount_out?: number | null;
      amount_in?: number | null;
      fx_amount?: number | null;
      fx_currency?: string | null;
      description: string;
    }>;
  };

  const kind: SourceKind = input.kind ?? "credit-card";
  const account = accountOverride ?? input.account ?? "(unknown)";
  const inputRows = input.rows ?? [];
  const warnings: string[] = [];

  const rows: ImportedTransaction[] = [];
  for (let i = 0; i < inputRows.length; i++) {
    const r = inputRows[i]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      warnings.push(`row ${i}: 日付形式不正 "${r.date}"`);
      continue;
    }
    const amountOut = typeof r.amount_out === "number" ? Math.round(r.amount_out) : null;
    const amountIn = typeof r.amount_in === "number" ? Math.round(r.amount_in) : null;
    if (amountOut == null && amountIn == null) {
      warnings.push(`row ${i}: amount 不明、 skip`);
      continue;
    }

    const sourceId = statementRowSourceId(account, r);
    rows.push({
      date: r.date,
      amount_out: amountOut,
      amount_in: amountIn,
      currency: "JPY",
      fx_amount: typeof r.fx_amount === "number" ? r.fx_amount : null,
      fx_currency: r.fx_currency ?? null,
      description: r.description,
      payee: r.payee ?? null,
      source_id: sourceId,
      account,
      metadata: { brand: `smart-${kind}` },
    });
  }
  return {
    source: kind,
    brand: `smart-${kind}`,
    account,
    rows,
    warnings,
  };
}
