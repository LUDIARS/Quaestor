/**
 * Claude Code CLI (`claude -p`) を spawn して事業計画の定性レビューを行う backend。
 *
 * ClaudePlanReviewer (Anthropic SDK / ANTHROPIC_API_KEY) と並ぶ別経路。 こちらは:
 *  - 機械的 API key 不要 (claude CLI 自身の auth = サブスクを使う)
 *  - claude-code-ocr.ts と同じ spawn 流儀。 ただし fire-and-forget ではなく
 *    stdout を集めて同期的に結果を得る (`--output-format json` のエンベロープを parse)
 *  - プロンプトは tool_use ではなく「厳密 JSON のみ出力」を指示し、 result から JSON を抽出
 *
 * 長いプロンプトは `-p` 値なし + stdin で渡す (Windows ENAMETOOLONG 回避)。
 * Windows では claude CLI に CLAUDE_CODE_GIT_BASH_PATH が要る。
 */

import {
  type PlanReviewer,
  type PlanReviewInput,
  type PlanReviewResult,
  SYSTEM_PROMPT,
  buildReviewUserText,
  normalizeReview,
} from "./plan-reviewer.js";
import { spawnClaude, extractEnvelopeResult, extractJsonObject } from "./claude-cli.js";

// 既存テスト互換のため claude-cli の抽出ヘルパーを再 export
export { extractEnvelopeResult, extractJsonObject } from "./claude-cli.js";

export interface ClaudeCliReviewerOptions {
  /** CLI 実行名。 既定 "claude" */
  cliPath?: string;
  /** Windows git-bash パス (env CLAUDE_CODE_GIT_BASH_PATH と同じ) */
  bashPath?: string;
  /** kill タイムアウト (ms)。 既定 120_000 */
  timeoutMs?: number;
  /** 実行関数の注入 (テスト用)。 prompt を受けて stdout 文字列を返す */
  runner?: (prompt: string) => Promise<string>;
}

export class ClaudeCliPlanReviewer implements PlanReviewer {
  constructor(private readonly opts: ClaudeCliReviewerOptions = {}) {}

  get modelName(): string {
    return "claude-cli";
  }

  async review(input: PlanReviewInput): Promise<PlanReviewResult> {
    const prompt = buildCliPrompt(input);
    const stdout = this.opts.runner
      ? await this.opts.runner(prompt)
      : await spawnClaude(prompt, this.opts);
    const resultText = extractEnvelopeResult(stdout);
    const obj = extractJsonObject(resultText);
    if (!obj) throw new Error("claude CLI から JSON を抽出できませんでした");
    return normalizeReview(obj);
  }
}

/** CLI 用プロンプト: tool_use の代わりに厳密 JSON 出力を指示 */
export function buildCliPrompt(input: PlanReviewInput): string {
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `${buildReviewUserText(input)}\n\n` +
    `# 出力形式 (厳守)\n` +
    `説明や前置きは一切書かず、 以下のスキーマの JSON オブジェクトだけを出力すること。\n` +
    `\`\`\`\n` +
    `{\n` +
    `  "score": <0..100 の整数>,\n` +
    `  "summary": "<2-3文の総評>",\n` +
    `  "findings": [\n` +
    `    { "severity": "error|warning|info", "area": "<対象セクション名 or 全体>", "message": "<指摘>", "suggestion": "<改善案>" }\n` +
    `  ]\n` +
    `}\n` +
    `\`\`\``
  );
}

/** claude CLI が使えそうか (明示 disable のみ判定、 実態は spawn error で判明) */
export function detectClaudeCli(): boolean {
  return process.env.QUAESTOR_PLAN_REVIEWER_CLI_DISABLE !== "1";
}
