/**
 * 検出差分の Opus 類推。
 *
 * computeDetectionDiff() が差分 (検出テキスト vs 真値) を出したとき、
 * Claude Opus 4.8 に「検出器がどう検出したか」を差分から類推させる。
 *  - 失敗種別 (localization=位置ずれ / recognition=読み違い / partial / none)
 *  - 仮説 (なぜその差分が出たか)
 *  - 改善案 (検出器/前処理をどう直すと精度が上がるか)
 *
 * 画像は渡さない (ユーザ指示「差分から類推」)。差分テキストのみを根拠にする。
 * tool_use で構造化出力を強制。ANTHROPIC_API_KEY 未設定なら生成しない (DI で undefined)。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { DetectionDiff, FieldDiff } from "./detection-eval.js";

export interface FieldInference {
  field: string;
  failureMode: "localization" | "recognition" | "partial" | "none";
  hypothesis: string;
  suggestedFix: string;
  confidence: "high" | "medium" | "low";
}

export interface DiffInference {
  summary: string;
  fields: FieldInference[];
  model: string;
}

export interface DiffEvaluator {
  /** 差分から検出挙動の指標を類推する。失敗時は null。 */
  evaluate(diff: DetectionDiff, engine: string): Promise<DiffInference | null>;
}

const SYSTEM_PROMPT = `あなたはレシート検出パイプラインの品質アナリスト。
検出器 (PaddleOCR / Tesseract 等) が各フィールドの bbox を当て、その領域のテキストを認識した。
入力は「検出テキスト」と「真値 (確定済み OCR 結果)」の差分。**画像は無い**。差分の形だけから、
検出器がどのように検出したか (挙動) を類推する。

各フィールドについて failureMode を判定:
- localization: bbox の位置/範囲がずれた疑い (別行・隣接フィールドを掴んだ、切れた)。
    手掛かり: 検出テキストが真値と全く別物、または真値の一部+余分な文字。
- recognition: 位置は合っていそうだが文字認識を誤った疑い (字形誤読・OCR ノイズ)。
    手掛かり: 検出テキストが真値に近い (1〜数文字違い、数字の取り違え)。
- partial: 真値の一部だけ取れている (途中で切れた)。
- none: 実質一致 (差分が軽微)。

hypothesis は差分の具体形に即して簡潔に。suggestedFix は検出器/前処理の具体的改善 (二値化・行マージ・言語モデル・解像度・bbox padding 等)。`;

const TOOL: Anthropic.Tool = {
  name: "report_detection_inference",
  description: "Report per-field inference of how the detector behaved, from the diff.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "全体所見 (1〜2 文)" },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            failureMode: { type: "string", enum: ["localization", "recognition", "partial", "none"] },
            hypothesis: { type: "string" },
            suggestedFix: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["field", "failureMode", "hypothesis", "suggestedFix", "confidence"],
        },
      },
    },
    required: ["summary", "fields"],
  },
};

export interface OpusDiffEvaluatorOptions {
  apiKey?: string;
  model?: string;
}

export class OpusDiffEvaluator implements DiffEvaluator {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: OpusDiffEvaluatorOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-opus-4-8";
  }

  async evaluate(diff: DetectionDiff, engine: string): Promise<DiffInference | null> {
    // 真値があり、かつ差分のあるフィールドだけ渡す (一致のみは送らない)
    const targets = diff.fields.filter(
      (f) => f.status === "mismatch" || f.status === "missing",
    );
    if (targets.length === 0) return null;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "report_detection_inference" },
      messages: [
        {
          role: "user",
          content: `検出エンジン: ${engine}\n\n差分 (検出テキスト vs 真値):\n${formatDiff(targets)}\n\nreport_detection_inference ツールで各フィールドの検出挙動を類推してください。`,
        },
      ],
    });

    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tu) return null;
    const input = tu.input as { summary?: unknown; fields?: unknown };
    const fields = Array.isArray(input.fields)
      ? input.fields.filter(isFieldInference)
      : [];
    return {
      summary: typeof input.summary === "string" ? input.summary : "",
      fields,
      model: this.model,
    };
  }
}

function formatDiff(fields: FieldDiff[]): string {
  return fields
    .map((f) => {
      const det = f.detectedText == null ? "(未検出)" : `"${f.detectedText}"`;
      return `- ${f.field} [${f.status}, 類似度 ${f.similarity}]: 検出=${det} / 真値="${f.referenceText}"`;
    })
    .join("\n");
}

function isFieldInference(x: unknown): x is FieldInference {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o["field"] === "string"
    && typeof o["hypothesis"] === "string"
    && typeof o["suggestedFix"] === "string";
}
