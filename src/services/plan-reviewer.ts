/**
 * 事業計画の定性レビューを Claude で行う。
 *
 * 設計方針 (security-mapper.ts と同じ流儀):
 *  - tool_use + tool_choice で構造化を強制
 *  - DI 可能な interface 化 (テストは fake を渡す)
 *  - model は判断精度が要るため Sonnet
 *  - 送信するのは事業計画の記述と集計数字のみ (口座番号等の個人特定情報は渡さない)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Finding, Severity } from "../business-plan/quant.js";

export interface PlanReviewInput {
  templateName: string;
  purpose: string;            // funding / subsidy / internal
  sections: { title: string; body: string }[];
  /** 定量サマリ (人間可読の数行)。 quant metrics を要約した文字列 */
  financialSummary: string;
}

export interface PlanReviewResult {
  score: number;              // 0..100
  summary: string;
  findings: Finding[];
}

export interface PlanReviewer {
  review(input: PlanReviewInput): Promise<PlanReviewResult>;
}

const SYSTEM_PROMPT = `あなたは日本の創業融資・補助金審査に精通した中小企業診断士。
与えられた事業計画 (記述セクション + 数字サマリ) を審査側の視点でレビューする。

観点:
- 記述と数字の整合性 (例: 売上計画の根拠が記述にあるか)
- 不足・薄い項目 (審査で必ず問われるのに書かれていない点)
- 資金調達 (融資 or 補助金) の通りやすさ・説得力
- 強み/差別化の具体性、 リスク認識

ルール:
- findings は審査で実際に指摘されうる粒度で。 severity は error=致命的(このままでは通らない) /
  warning=要改善 / info=助言。 area は対象セクションのタイトル、 全体なら "全体"。
- message は何が問題か、 suggestion はどう直すかを日本語で簡潔に。
- score は 0..100 で資金調達の通りやすさの総合点。 summary は2-3文の総評。
- 数字そのものの検算は別系統 (定量検算) が行うため、 ここでは「数字と記述の食い違い」や
  「根拠の薄さ」に集中する。`;

const TOOL: Anthropic.Tool = {
  name: "report_review",
  description: "Report a structured qualitative review of a business plan.",
  input_schema: {
    type: "object",
    properties: {
      score: { type: "number", description: "0..100 overall fundability score" },
      summary: { type: "string", description: "2-3 sentence overall assessment in Japanese" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["error", "warning", "info"] },
            area: { type: "string", description: "対象セクションのタイトル or 全体" },
            message: { type: "string" },
            suggestion: { type: "string" },
          },
          required: ["severity", "area", "message"],
        },
      },
    },
    required: ["score", "summary", "findings"],
  },
};

export interface AnthropicReviewerOptions {
  apiKey?: string;
  model?: string;
}

export class ClaudePlanReviewer implements PlanReviewer {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicReviewerOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-sonnet-4-6";
  }

  get modelName(): string {
    return this.model;
  }

  async review(input: PlanReviewInput): Promise<PlanReviewResult> {
    const sectionsText = input.sections
      .map((s) => `## ${s.title}\n${s.body.trim() || "(未記入)"}`)
      .join("\n\n");
    const userText =
      `テンプレート: ${input.templateName} / 目的: ${input.purpose}\n\n` +
      `# 記述\n${sectionsText}\n\n# 数字サマリ\n${input.financialSummary}\n\n` +
      `report_review ツールでレビュー結果を返してください。`;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "report_review" },
      messages: [{ role: "user", content: userText }],
    });

    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tu) throw new Error("no tool_use in response");
    return normalizeReview(tu.input as Record<string, unknown>);
  }
}

/** LLM 出力を型に正規化 */
export function normalizeReview(input: Record<string, unknown>): PlanReviewResult {
  const score = typeof input.score === "number" ? Math.max(0, Math.min(100, Math.round(input.score))) : 0;
  const summary = typeof input.summary === "string" ? input.summary : "";
  const rawFindings = Array.isArray(input.findings) ? input.findings : [];
  const findings: Finding[] = rawFindings.map((f) => normalizeFinding(f as Record<string, unknown>));
  return { score, summary, findings };
}

function normalizeFinding(f: Record<string, unknown>): Finding {
  const sev = f.severity;
  const severity: Severity = sev === "error" || sev === "warning" || sev === "info" ? sev : "info";
  return {
    severity,
    area: typeof f.area === "string" && f.area ? f.area : "全体",
    code: "qualitative",
    message: typeof f.message === "string" ? f.message : "",
    suggestion: typeof f.suggestion === "string" ? f.suggestion : undefined,
  };
}
