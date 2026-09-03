/**
 * Claude Code CLI (`claude -p --output-format json`) を spawn して構造化 JSON を得る共通ヘルパー。
 * plan-reviewer-cli / subsidy-matcher が共有する (機械的 API key 不要 = サブスク auth を使う)。
 *
 * 長プロンプトは stdin で渡す (Windows ENAMETOOLONG 回避)。 Windows は CLAUDE_CODE_GIT_BASH_PATH が要る。
 */

import { spawn } from "node:child_process";
import { reportConcordiaCostOneShot } from "./concordia-cost.js";

export interface ClaudeCliOptions {
  cliPath?: string;       // 既定 "claude"
  bashPath?: string;      // env CLAUDE_CODE_GIT_BASH_PATH と同じ
  timeoutMs?: number;     // 既定 120_000
  /**
   * `--model`。 未指定 / null で CLI 既定に委ねる (対話側で使い切ったモデルの上限に巻き込まれ得る、
   * spec/feature/receipt-ocr-claude-cli.md)。 shell 経由で渡すため英数字・`.`・`_`・`-` 以外は無視する。
   */
  model?: string | null;
  /**
   * `--allowedTools`。 `-p` (非対話) ではツール権限の確認ができないため、 画像を Read で視認させる
   * ような用途は最小限のツールだけ許可する (例 ["Read"])。
   */
  allowedTools?: string[];
  /** Cost telemetry に記録する prompt。 ローカル絶対パス等を含む場合は安全な要約を渡す。 */
  costPrompt?: string;
}

const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** shell 経由の spawn で引数がコマンドに化けないよう、 安全な形の値だけ通す。 */
export function claudeCliArgs(opts: ClaudeCliOptions): string[] {
  const args = ["-p", "--output-format", "json"];
  if (typeof opts.model === "string" && SAFE_ARG.test(opts.model)) args.push("--model", opts.model);
  const tools = (opts.allowedTools ?? []).filter((t) => SAFE_ARG.test(t));
  if (tools.length > 0) args.push("--allowedTools", tools.join(","));
  return args;
}

/**
 * `claude -p --output-format json` の stdout から result テキストを取り出す。
 * 形態: (a) 単一 `{type:"result", result}`、 (b) イベント配列、 (c) NDJSON のいずれにも対応。
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
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = fromEvent(JSON.parse(lines[i]!));
        if (r !== null) return r;
      } catch { /* skip non-JSON line */ }
    }
  }
  return trimmed;
}

/** テキストから最初の JSON 値 (オブジェクト or 配列) を抽出 */
export function extractJsonValue(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  // オブジェクト
  const ob = text.indexOf("{"); const oe = text.lastIndexOf("}");
  if (ob !== -1 && oe > ob) candidates.push(text.slice(ob, oe + 1));
  // 配列
  const ab = text.indexOf("["); const ae = text.lastIndexOf("]");
  if (ab !== -1 && ae > ab) candidates.push(text.slice(ab, ae + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

/** テキストから最初の JSON オブジェクトを抽出 (配列は無視) */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const v = extractJsonValue(text);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** claude CLI を spawn し stdout 文字列を返す */
export function spawnClaude(prompt: string, opts: ClaudeCliOptions = {}): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const startedAt = Date.now();
    const cliPath = opts.cliPath ?? "claude";
    const costPrompt = opts.costPrompt ?? prompt;
    const env = { ...process.env };
    const bashPath = opts.bashPath ?? process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;

    const child = spawn(cliPath, claudeCliArgs(opts), {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    let out = "";
    let errOut = "";
    let recorded = false;
    let timer: NodeJS.Timeout | null = null;
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { errOut += d.toString(); });
    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      if (!recorded) {
        recorded = true;
        void reportConcordiaCostOneShot({
          service: "quaestor",
          provider: "claude",
          command: `${cliPath} -p --output-format json`,
          cwd: process.cwd(),
          prompt: costPrompt,
          status: "error",
          exit_code: -1,
          duration_ms: Date.now() - startedAt,
          metadata: { error: e.message },
        });
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const ok = code === 0 || out.trim().length > 0;
      if (!recorded) {
        recorded = true;
        void reportConcordiaCostOneShot({
          service: "quaestor",
          provider: "claude",
          command: `${cliPath} -p --output-format json`,
          cwd: process.cwd(),
          prompt: costPrompt,
          status: ok ? "ok" : "error",
          exit_code: code,
          duration_ms: Date.now() - startedAt,
          metadata: { stderr: errOut.slice(0, 1000) },
        });
      }
      if (code === 0 || out.trim()) resolveOut(out);
      else reject(new Error(`claude CLI exited ${code}: ${errOut.slice(0, 300)}`));
    });

    child.stdin.end(prompt);
    timer = setTimeout(() => {
      if (!recorded) {
        recorded = true;
        void reportConcordiaCostOneShot({
          service: "quaestor",
          provider: "claude",
          command: `${cliPath} -p --output-format json`,
          cwd: process.cwd(),
          prompt: costPrompt,
          status: "timeout",
          exit_code: -1,
          duration_ms: Date.now() - startedAt,
        });
      }
      try { child.kill("SIGTERM"); } catch { /* noop */ }
    }, opts.timeoutMs ?? 120_000);
    timer.unref();
  });
}

/** prompt を投げ、 result から JSON 値を抽出して返す (失敗時 null) */
export async function runClaudeCliJson(prompt: string, opts: ClaudeCliOptions = {}): Promise<unknown> {
  const stdout = await spawnClaude(prompt, opts);
  return extractJsonValue(extractEnvelopeResult(stdout));
}

/** claude CLI が使えそうか (明示 disable のみ判定、 実態は spawn error で判明) */
export function detectClaudeCli(): boolean {
  return process.env.QUAESTOR_CLAUDE_CLI_DISABLE !== "1";
}
