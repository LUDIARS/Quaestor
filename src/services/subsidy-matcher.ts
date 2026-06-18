/**
 * 事業計画 ⇄ 補助金 の要件マッチングを Claude で行う。
 *
 * 既定は claude CLI 経路 (claude-cli.ts、 サブスク auth、 API key 不要)。
 * テストは runner を注入して spawn を回避する。 DI 可能な interface 化。
 */

import { runClaudeCliJson, detectClaudeCli, type ClaudeCliOptions } from "./claude-cli.js";

export type Fit = "high" | "medium" | "low";

export interface SubsidyBrief {
  id: number;
  name: string;
  target?: string | null;
  requirements?: string | null;
}

export interface SubsidyMatchInput {
  /** 事業計画の記述 + 数字サマリを連結したテキスト */
  planSummary: string;
  subsidies: SubsidyBrief[];
}

export interface SubsidyMatch {
  subsidy_id: number;
  fit: Fit;
  reasoning: string;
}

export interface SubsidyMatcher {
  match(input: SubsidyMatchInput): Promise<SubsidyMatch[]>;
}

const SYSTEM = `あなたは日本の補助金・助成金の申請支援に精通したアドバイザー。
与えられた事業計画と、 候補となる補助金リストを突合し、 各補助金について
その計画が要件に合致しそうか (fit) と根拠 (reasoning) を判定する。

ルール:
- fit: high=要件を満たし採択を狙える / medium=一部条件次第で可能性あり / low=対象外に近い
- reasoning は対象者・要件と計画内容の対応を日本語で簡潔に。 推測は推測と明示する
- 候補に無い補助金を創作しない。 与えられた id のみ使う`;

export interface ClaudeSubsidyMatcherOptions extends ClaudeCliOptions {
  /** prompt を受けて JSON 値を返す注入 (テスト用)。 既定は runClaudeCliJson */
  runner?: (prompt: string) => Promise<unknown>;
}

export class ClaudeSubsidyMatcher implements SubsidyMatcher {
  constructor(private readonly opts: ClaudeSubsidyMatcherOptions = {}) {}

  async match(input: SubsidyMatchInput): Promise<SubsidyMatch[]> {
    if (input.subsidies.length === 0) return [];
    const prompt = buildMatchPrompt(input);
    const value = this.opts.runner
      ? await this.opts.runner(prompt)
      : await runClaudeCliJson(prompt, this.opts);
    return normalizeMatches(value, new Set(input.subsidies.map((s) => s.id)));
  }
}

export function buildMatchPrompt(input: SubsidyMatchInput): string {
  const list = input.subsidies
    .map((s) => `- id=${s.id} 名称:${s.name}\n  対象:${s.target ?? "(記載なし)"}\n  要件:${(s.requirements ?? "(記載なし)").replace(/\n/g, " / ")}`)
    .join("\n");
  return (
    `${SYSTEM}\n\n` +
    `# 事業計画\n${input.planSummary}\n\n` +
    `# 補助金候補\n${list}\n\n` +
    `# 出力形式 (厳守)\n` +
    `説明や前置きを書かず、 以下の JSON 配列だけを出力すること。 関連が low のものも含め全候補を返す。\n` +
    `\`\`\`\n` +
    `[ { "subsidy_id": <id>, "fit": "high|medium|low", "reasoning": "<根拠>" } ]\n` +
    `\`\`\``
  );
}

/** LLM 出力を正規化。 候補 id 集合に無いものは捨てる */
export function normalizeMatches(value: unknown, validIds: Set<number>): SubsidyMatch[] {
  const arr = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { matches?: unknown }).matches)
      ? (value as { matches: unknown[] }).matches
      : [];
  const out: SubsidyMatch[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.subsidy_id === "number" ? r.subsidy_id : Number(r.subsidy_id);
    if (!Number.isInteger(id) || !validIds.has(id)) continue;
    const fit: Fit = r.fit === "high" || r.fit === "medium" || r.fit === "low" ? r.fit : "low";
    out.push({ subsidy_id: id, fit, reasoning: typeof r.reasoning === "string" ? r.reasoning : "" });
  }
  // fit の高い順に並べる
  const rank: Record<Fit, number> = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => rank[a.fit] - rank[b.fit]);
  return out;
}

/** app.ts の resolve で使う: claude CLI があれば matcher を返す */
export function resolveSubsidyMatcher(
  opt: SubsidyMatcher | "auto" | "disabled" | undefined,
): SubsidyMatcher | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  if (!detectClaudeCli()) return undefined;
  return new ClaudeSubsidyMatcher();
}
