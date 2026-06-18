/**
 * Claude Code CLI (`claude -p --output-format json`) を spawn して構造化 JSON を得る共通ヘルパー。
 * plan-reviewer-cli / subsidy-matcher が共有する (機械的 API key 不要 = サブスク auth を使う)。
 *
 * 長プロンプトは stdin で渡す (Windows ENAMETOOLONG 回避)。 Windows は CLAUDE_CODE_GIT_BASH_PATH が要る。
 */

import { spawn } from "node:child_process";

export interface ClaudeCliOptions {
  cliPath?: string;       // 既定 "claude"
  bashPath?: string;      // env CLAUDE_CODE_GIT_BASH_PATH と同じ
  timeoutMs?: number;     // 既定 120_000
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

/** prompt を投げ、 result から JSON 値を抽出して返す (失敗時 null) */
export async function runClaudeCliJson(prompt: string, opts: ClaudeCliOptions = {}): Promise<unknown> {
  const stdout = await spawnClaude(prompt, opts);
  return extractJsonValue(extractEnvelopeResult(stdout));
}

/** claude CLI が使えそうか (明示 disable のみ判定、 実態は spawn error で判明) */
export function detectClaudeCli(): boolean {
  return process.env.QUAESTOR_CLAUDE_CLI_DISABLE !== "1";
}
