/**
 * 未知 payee の按分率/科目コードを成長型ブラックボックス (@ludiars/blackbox) で学習する。
 *
 * apportionment_rules.resolve が fallback (rate=0 / code=124 事業主貸) になる payee が対象。
 * LLM (claude CLI) が {rate, code} を判定しつつルール候補を提案 → 影評価で信頼を積み、
 * trial 発火への人間 OK で auto (卒業) → apportionment_rules に regex ルールとして実体化。
 * 以後その payee は既存の決定的 resolve (journal 等) が引き受け、LLM は不要になる。
 *
 * 設計正本: Lapilli packages/blackbox/DESIGN.md §7。
 */

import type Database from "better-sqlite3";
import {
  makeSqliteBlackBox,
  type BlackBox, type Condition, type DecisionRecord, type DomainStats,
  type FeatureMap, type LlmContext, type LlmJudgement, type Rule as BlackboxRule,
} from "@ludiars/blackbox";
import { normalizePayee } from "../shared/text.js";
import type { ApportionmentRulesRepo } from "../db/apportionment-rules-repo.js";
import type { AccountCodesRepo } from "../db/account-codes-repo.js";
import { runClaudeCliJson } from "./claude-cli.js";

export const DOMAIN_APPORTIONMENT = "accounting.apportionment";

export interface ApportionmentInput {
  payee: string;
  source: string | null;
  avgAmountOut: number;
  txCount: number;
}
export interface ApportionmentOutput {
  rate: number;   // 0..1 経費按分率
  code: number;   // 借方科目コード
}

/** 金額帯 (ルール条件に使える離散 feature)。 */
export function amountBand(avg: number): string {
  if (avg < 1_000) return "<1k";
  if (avg < 10_000) return "1k-10k";
  if (avg < 100_000) return "10k-100k";
  return "100k+";
}

export function apportionmentFeatures(input: ApportionmentInput): FeatureMap {
  return {
    payee: normalizePayee(input.payee) ?? input.payee,
    source: input.source ?? "",
    amountBand: amountBand(input.avgAmountOut),
    txCount: input.txCount,
  };
}

/** LLM 判定境界 (plan-reviewer 等と同じ DI 流儀。 テストは fake を注入)。 */
export interface ApportionmentLlm {
  judge(
    input: ApportionmentInput,
    features: FeatureMap,
    context: LlmContext,
  ): Promise<LlmJudgement<ApportionmentOutput>>;
}

/** claude CLI (サブスク auth) 実装。 科目コード一覧をプロンプトに与える。 */
export class ClaudeCliApportionmentLlm implements ApportionmentLlm {
  constructor(private readonly accounts: AccountCodesRepo) {}

  async judge(
    input: ApportionmentInput,
    features: FeatureMap,
    context: LlmContext,
  ): Promise<LlmJudgement<ApportionmentOutput>> {
    const codes = this.accounts.list()
      .map((a) => `${a.code}: ${a.name} (${a.kind})`)
      .join("\n");
    const retired = context.retiredRules.length
      ? `\n過去に撤回された (誤りだった) ルール — 同じ提案はしないこと:\n${context.retiredRules.map((r) => `- ${r.description}: ${r.whenText}`).join("\n")}`
      : "";
    const prompt = `あなたは個人事業主の会計アシスタントです。クレカ/銀行明細の店名から、経費按分率と借方科目コードを判定します。

科目コード一覧:
${codes}

店名 (正規化済み): ${features.payee}
取引元: ${input.source ?? "不明"} / 平均支出額: ${Math.round(input.avgAmountOut)} 円 / 取引回数: ${input.txCount}
${retired}
判定基準: 事業関連 100% なら rate=1.0、事業/家計混在は 0.5 等、純家計は rate=0 + code=124 (事業主貸)。

さらに、この判定が payee の一致で再現できるなら proposedRule に Condition を書いてください
(feature 名: payee, source, amountBand。payee の完全一致 {"op":"cmp","feature":"payee","cmp":"==","value":"..."} を推奨)。

次の JSON だけを返してください:
{"rate": 0.0-1.0, "code": <科目コード>, "confidence": 0.0-1.0, "rationale": "理由(日本語)",
 "proposedRule": {"description":"...","when":{"op":"cmp","feature":"payee","cmp":"==","value":"${features.payee}"},"output":{"rate":1.0,"code":26},"confidence":0.8}}
proposedRule は自信が無ければ省略可。`;

    // 保険: LLM 不調時は家計扱い (誤経費計上より安全側)
    let output: ApportionmentOutput = { rate: 0, code: 124 };
    let confidence = 0.3;
    let rationale = "LLM 応答が得られず家計扱いで暫定";
    let proposedRule: LlmJudgement<ApportionmentOutput>["proposedRule"];
    try {
      const j = await runClaudeCliJson(prompt) as Record<string, unknown> | null;
      if (j && typeof j === "object") {
        if (typeof j.rate === "number" && typeof j.code === "number") {
          output = { rate: clamp01(j.rate), code: Math.trunc(j.code) };
        }
        if (typeof j.confidence === "number") confidence = clamp01(j.confidence);
        if (typeof j.rationale === "string") rationale = j.rationale;
        proposedRule = parseProposedRule(j.proposedRule, output);
      }
    } catch { /* 保険値を使う */ }
    return { output, confidence, rationale, proposedRule };
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseProposedRule(
  raw: unknown,
  output: ApportionmentOutput,
): LlmJudgement<ApportionmentOutput>["proposedRule"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!r.when || typeof r.when !== "object") return undefined;
  return {
    description: typeof r.description === "string" ? r.description : "LLM 提案ルール",
    when: r.when as Condition,   // validateCondition は engine 側 propose で通す前提だが、ここでも形だけ通す
    output: (r.output as ApportionmentOutput | undefined) ?? output,
    confidence: typeof r.confidence === "number" ? clamp01(r.confidence) : 0.7,
  };
}

export interface ApportionmentAdvisorDeps {
  db: Database.Database;
  rules: ApportionmentRulesRepo;
  accounts: AccountCodesRepo;
  /** undefined = LLM 無し (advise は 503 相当、レビュー/ルール参照は可)。 */
  llm?: ApportionmentLlm;
}

export interface AdviseResult {
  payee: string;
  rate: number;
  code: number;
  source: "rule" | "llm";
  status: "auto" | "pending_review";
  rationale: string;
  decisionId: number;
}

export class ApportionmentAdvisor {
  private readonly bb: BlackBox;

  constructor(private readonly deps: ApportionmentAdvisorDeps) {
    this.bb = makeSqliteBlackBox(deps.db);
  }

  get llmAvailable(): boolean {
    return !!this.deps.llm;
  }

  /** apportionment_rules 未マッチ (fallback) の payee を支出額順に列挙する。 */
  listUnknownPayees(limit = 50): ApportionmentInput[] {
    const rows = this.deps.db.prepare(
      `SELECT payee, source, AVG(amount_out) AS avg_out, COUNT(*) AS n
       FROM transactions
       WHERE amount_out > 0 AND payee IS NOT NULL AND is_transfer = 0
       GROUP BY payee, source
       ORDER BY SUM(amount_out) DESC`,
    ).all() as Array<{ payee: string; source: string | null; avg_out: number; n: number }>;
    const out: ApportionmentInput[] = [];
    for (const r of rows) {
      if (this.deps.rules.resolve(r.payee).rule_id !== null) continue;
      out.push({ payee: r.payee, source: r.source, avgAmountOut: r.avg_out, txCount: r.n });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 未知 payee を blackbox で判定する。 学習済み (trial/auto) ルールは LLM 無しで即決、
   * 未知は LLM 判定 + ルール候補蓄積。 呼ぶたびに影評価が進み、繰り返すほど LLM 依存が減る。
   */
  async adviseUnknown(limit = 10): Promise<AdviseResult[]> {
    const llm = this.deps.llm;
    if (!llm) throw new Error("apportionment LLM is not available");
    const targets = this.listUnknownPayees(limit);
    const results: AdviseResult[] = [];
    for (const input of targets) {
      const features = apportionmentFeatures(input);
      const { decision, decisionId } = await this.bb.engine.decide<ApportionmentInput, ApportionmentOutput>(
        DOMAIN_APPORTIONMENT, input, features,
        (i, f, ctx) => llm.judge(i, f, ctx),
      );
      results.push({
        payee: input.payee,
        rate: decision.output.rate,
        code: decision.output.code,
        source: decision.source,
        status: decision.status,
        rationale: decision.rationale,
        decisionId,
      });
    }
    return results;
  }

  /** レビュー待ち判断。 */
  pending(limit = 50): DecisionRecord[] {
    return this.bb.ledger.listPending(DOMAIN_APPORTIONMENT, limit);
  }

  /**
   * 人間の OK/NG。 ルールが auto に卒業したら apportionment_rules に実体化し、
   * 以後は journal 等の決定的 resolve が引き受ける。
   */
  review(decisionId: number, verdict: "ok" | "ng"): { ok: boolean; rule: BlackboxRule | null; materializedRuleId: number | null } {
    const res = this.bb.engine.recordVerdict(decisionId, verdict);
    if (!res.ok) return { ok: false, rule: null, materializedRuleId: null };
    let materializedRuleId: number | null = null;
    if (res.ruleUpdated?.state === "auto") {
      materializedRuleId = this.materialize(res.ruleUpdated);
    }
    return { ok: true, rule: res.ruleUpdated ?? null, materializedRuleId };
  }

  /**
   * 卒業ルールを apportionment_rules の regex ルールへ変換する。
   * payee 条件 (== / in) のみ変換可能。 それ以外の条件は blackbox 内に留まる。
   * note に指紋を刻み二重実体化を防ぐ。
   */
  materialize(rule: BlackboxRule): number | null {
    const pattern = payeePattern(rule.when);
    if (!pattern) return null;
    const output = rule.output as ApportionmentOutput | null;
    if (!output || typeof output.rate !== "number" || typeof output.code !== "number") return null;
    const marker = `blackbox:${fingerprintShort(rule.fingerprint)}`;
    const exists = this.deps.rules.list(true).some((r) => r.note?.includes(marker));
    if (exists) return null;
    return this.deps.rules.insert({
      pattern,
      rate: output.rate,
      code: output.code,
      priority: 500, // seed (10-300 台) より後ろ、fallback より前
      note: `${rule.description} (${marker})`,
    });
  }

  listRules(): BlackboxRule[] {
    return this.bb.rules.listByDomain(DOMAIN_APPORTIONMENT);
  }

  stats(): DomainStats {
    return this.bb.stats(DOMAIN_APPORTIONMENT);
  }
}

/** Condition から payee の regex パターンを作る (== / in のみ)。 */
export function payeePattern(when: Condition): string | null {
  if (when.op === "cmp" && when.feature === "payee" && when.cmp === "==" && typeof when.value === "string") {
    return escapeRegex(when.value);
  }
  if (when.op === "in" && when.feature === "payee") {
    const vals = when.values.filter((v): v is string => typeof v === "string");
    if (vals.length === 0) return null;
    return vals.map(escapeRegex).join("|");
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fingerprintShort(fp: string): string {
  // 正規化 JSON の先頭を潰した短い識別子 (note 用)。FNV-1a 32bit。
  let h = 0x811c9dc5;
  for (let i = 0; i < fp.length; i++) {
    h ^= fp.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
