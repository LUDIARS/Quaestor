/**
 * 検出差分の LLM 類推 (Claude CLI 経由)。
 *
 * computeDetectionDiff() が差分 (検出テキスト vs 真値) を出したとき、
 * Claude CLI に「検出器がどう検出したか」を差分から類推させる。
 *  - 失敗種別 (localization=位置ずれ / recognition=読み違い / partial / none)
 *  - 仮説 (なぜその差分が出たか)
 *  - 改善案 (検出器/前処理をどう直すと精度が上がるか)
 *
 * 画像は渡さない (ユーザ指示「差分から類推」)。差分テキストのみを根拠にする。
 */

import { runClaudeCliJson, type ClaudeCliOptions } from "./claude-cli.js";
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

export interface OpusDiffEvaluatorOptions extends ClaudeCliOptions {
  runner?: (prompt: string) => Promise<unknown>;
}

export class OpusDiffEvaluator implements DiffEvaluator {
  constructor(private readonly opts: OpusDiffEvaluatorOptions = {}) {}

  async evaluate(diff: DetectionDiff, engine: string): Promise<DiffInference | null> {
    const targets = diff.fields.filter(
      (f) => f.status === "mismatch" || f.status === "missing",
    );
    if (targets.length === 0) return null;

    const prompt = buildEvalPrompt(engine, targets);
    const json = this.opts.runner
      ? await this.opts.runner(prompt)
      : await runClaudeCliJson(prompt, this.opts);
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const input = json as { summary?: unknown; fields?: unknown };
    const fields = Array.isArray(input.fields)
      ? input.fields.filter(isFieldInference)
      : [];
    return {
      summary: typeof input.summary === "string" ? input.summary : "",
      fields,
      model: "claude-cli",
    };
  }
}

function buildEvalPrompt(engine: string, targets: FieldDiff[]): string {
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `検出エンジン: ${engine}\n\n` +
    `差分 (検出テキスト vs 真値):\n${formatDiff(targets)}\n\n` +
    `各フィールドの検出挙動を類推してください。\n\n` +
    `# 出力形式 (厳守)\n` +
    `説明や前置きは一切書かず、以下のスキーマの JSON オブジェクトだけを出力すること。\n` +
    `\`\`\`\n` +
    `{\n` +
    `  "summary": "<全体所見 1〜2 文>",\n` +
    `  "fields": [\n` +
    `    {\n` +
    `      "field": "<フィールド名>",\n` +
    `      "failureMode": "<localization|recognition|partial|none>",\n` +
    `      "hypothesis": "<差分の具体形に即した仮説>",\n` +
    `      "suggestedFix": "<検出器/前処理の具体的改善>",\n` +
    `      "confidence": "<high|medium|low>"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `\`\`\``
  );
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
