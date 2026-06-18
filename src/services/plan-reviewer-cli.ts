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

import { spawn } from "node:child_process";
import {
  type PlanReviewer,
  type PlanReviewInput,
  type PlanReviewResult,
  SYSTEM_PROMPT,
  buildReviewUserText,
  normalizeReview,
} from "./plan-reviewer.js";

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

/**
 * `claude -p --output-format json` の stdout から result テキストを取り出す。
 * バージョンにより形が変わる: (a) 単一 `{type:"result", result}` オブジェクト、
 * (b) イベント配列 `[{type:"system"...}, ..., {type:"result", result}]`、
 * (c) NDJSON (1行1イベント)。 いずれも result 要素の `.result` を返す。
 */
export function extractEnvelopeResult(stdout: string): string {
  const trimmed = stdout.trim();
  const fromEvent = (e: unknown): string | null => {
    if (e && typeof e === "object" && (e as { type?: string }).type === "result") {
      const r = (e as { result?: unknown }).result;
      if (typeof r === "string") return r;
    }
    return null;
  };
  // (a)/(b): 全体が JSON
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const r = fromEvent(parsed[i]);
        if (r !== null) return r;
      }
    } else {
      const r = fromEvent(parsed);
      if (r !== null) return r;
      if (typeof (parsed as { result?: unknown }).result === "string") {
        return (parsed as { result: string }).result;
      }
    }
  } catch {
    // (c) NDJSON: 行ごとに parse して result イベントを探す
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = fromEvent(JSON.parse(lines[i]!));
        if (r !== null) return r;
      } catch { /* skip non-JSON line */ }
    }
  }
  // JSON でなければ生 stdout (--output-format text fallback)
  return trimmed;
}

/** テキストから最初の JSON オブジェクトを抽出 (```フェンス or 生テキストの { .. } ) */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  // ```json ... ``` フェンス優先
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c) as Record<string, unknown>; } catch { /* try next */ }
  }
  return null;
}

function spawnClaude(prompt: string, opts: ClaudeCliReviewerOptions): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const env = { ...process.env };
    const bashPath = opts.bashPath ?? process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;

    const child = spawn(opts.cliPath ?? "claude", ["-p", "--output-format", "json"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    let out = "";
    let errOut = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { errOut += d.toString(); });
    child.once("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0 || out.trim()) resolveOut(out);
      else reject(new Error(`claude CLI exited ${code}: ${errOut.slice(0, 300)}`));
    });

    child.stdin.end(prompt);

    const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* noop */ } }, opts.timeoutMs ?? 120_000);
    t.unref();
  });
}

/** claude CLI が使えそうか (明示 disable のみ判定、 実態は spawn error で判明) */
export function detectClaudeCli(): boolean {
  return process.env.QUAESTOR_PLAN_REVIEWER_CLI_DISABLE !== "1";
}
