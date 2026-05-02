/**
 * Anthropic vision を使ったレシート OCR クライアント。
 *
 * 設計方針:
 *  - 構造化抽出は **tool_use** で受ける (tool_choice で強制) — 自由テキストを後付けでパースしない
 *  - system prompt は cache_control: ephemeral で 1 セッション内 multi-receipt の入力を節約
 *  - 既定 model は **Haiku 4.5** — 単純な OCR に Sonnet/Opus は要らない、 速度・コスト重視
 *  - DI 可能: テストでは fake client を渡せるよう interface 化
 */

import Anthropic from "@anthropic-ai/sdk";

export interface ReceiptOcrResult {
  date: string | null;            // ISO yyyy-mm-dd
  payee: string | null;
  total: number | null;           // 整数 (JPY)
  currency: string;               // 既定 "JPY"
  items: { name: string; price: number; qty?: number }[];
  raw: string;                    // tool_use input の JSON 文字列 (ocr_raw に保存)
  /** 信頼度メタ (LLM が "uncertain" を返したら manual review に倒す) */
  confidence: "high" | "medium" | "low";
}

export interface OcrClient {
  extract(image: Buffer, mime: "image/jpeg" | "image/png"): Promise<ReceiptOcrResult>;
}

const SYSTEM_PROMPT = `あなたは日本のレシート / 領収書を構造化抽出する OCR アシスタント。
入力画像から以下を JSON で返却する:
- date: 日付 (yyyy-mm-dd 形式)。 不明なら null
- payee: 店名・発行元 (日本語そのまま、 法人格 含めてよい)。 不明なら null
- total: 合計金額 (整数、 円)。 税込総額。 不明なら null
- currency: 通貨コード (既定 "JPY")
- items: 個別商品 (name, price, qty)。 自信が無ければ空配列
- confidence: "high" / "medium" / "low" 全項目の確信度。 ぼやけ / 切れ / 紙折れ等で不確実なら下げる

注意:
- レシート以外 (背景、 メニュー、 名刺、 広告) なら confidence=low、 payee=null とする
- 数字は半角に正規化、 カンマ・全角・通貨記号は除いて整数化
- 商品名は明確な文字のみ拾う、 推測しない
`;

const TOOL: Anthropic.Tool = {
  name: "extract_receipt",
  description: "Extract structured fields from a Japanese receipt or invoice image.",
  input_schema: {
    type: "object",
    properties: {
      date: { type: ["string", "null"], description: "ISO yyyy-mm-dd if visible, else null" },
      payee: { type: ["string", "null"], description: "store name or issuer in Japanese" },
      total: { type: ["integer", "null"], description: "total amount in JPY (tax-inclusive)" },
      currency: { type: "string", description: "ISO 4217 currency code" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "integer" },
            qty: { type: "integer" },
          },
          required: ["name", "price"],
        },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["date", "payee", "total", "currency", "items", "confidence"],
  },
};

export interface AnthropicOcrOptions {
  apiKey?: string;
  model?: string;
}

export class AnthropicOcrClient implements OcrClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicOcrOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-haiku-4-5-20251001";
  }

  async extract(image: Buffer, mime: "image/jpeg" | "image/png"): Promise<ReceiptOcrResult> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "extract_receipt" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mime, data: image.toString("base64") },
            },
            { type: "text", text: "extract_receipt ツールでこのレシートを構造化してください。" },
          ],
        },
      ],
    });

    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tu) throw new Error("no tool_use in response");
    const input = tu.input as Record<string, unknown>;
    return {
      date: typeof input.date === "string" ? input.date : null,
      payee: typeof input.payee === "string" ? input.payee : null,
      total: typeof input.total === "number" ? Math.round(input.total) : null,
      currency: typeof input.currency === "string" ? input.currency : "JPY",
      items: Array.isArray(input.items)
        ? input.items
            .filter((x): x is { name: string; price: number; qty?: number } =>
              typeof x === "object" && x !== null &&
              typeof (x as { name?: unknown }).name === "string" &&
              typeof (x as { price?: unknown }).price === "number",
            )
            .map((x) => ({
              name: x.name,
              price: Math.round(x.price),
              qty: typeof x.qty === "number" ? Math.round(x.qty) : undefined,
            }))
        : [],
      raw: JSON.stringify(input),
      confidence: (input.confidence === "high" || input.confidence === "medium" || input.confidence === "low")
        ? input.confidence
        : "low",
    };
  }
}
