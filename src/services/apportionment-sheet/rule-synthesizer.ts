/**
 * 按分シートの提案行から apportionment_rules を生成する。 決定的で LLM を呼ばない。
 *
 * pattern は正規化済み店名の完全一致 (`^…$`、 regex エスケープ済み)。 matchRule は normalizePayee 後の
 * 文字列に i フラグで当てるので、 payee_norm をそのまま使える。
 * priority は 300 (seed の 10〜100 より後、 blackbox 卒業ルール 500 より前)。
 * 現行ルールと食い違う行 (differs) は override 指定時のみ、 既存より小さい priority で上書きする。
 *
 * @implements SPEC-APPORTIONMENT-SHEET-002 (spec/feature/household-bookkeeping.md)
 */

import type { ApportionmentRulesRepo } from "../../db/apportionment-rules-repo.js";
import type { SheetRow } from "./sheet-builder.js";

export const SHEET_RULE_PRIORITY = 300;

export interface SynthesizeOptions {
  dry_run: boolean;
  /** 対象を payee_norm で絞る (未指定なら proposal 全件) */
  payees?: string[];
  /** 観測回数がこれ未満の提案は作らない (既定 1) */
  min_occurrences?: number;
  /** differs 行も上書きする */
  override?: boolean;
  /** note に刻む日付 (既定 今日、 テストで固定可) */
  today?: string;
}

export interface SynthesizedCandidate {
  payee_norm: string;
  pattern: string;
  rate: number;
  code: number;
  priority: number;
  action: "create" | "update" | "skip";
  reason: string;
  rule_id?: number;
}

export interface SynthesizeResult {
  dry_run: boolean;
  candidates: SynthesizedCandidate[];
  created: number;
  updated: number;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function exactPattern(payeeNorm: string): string {
  return `^${escapeRegex(payeeNorm)}$`;
}

export function synthesizeRules(rows: SheetRow[], rules: ApportionmentRulesRepo, opts: SynthesizeOptions): SynthesizeResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const minOcc = opts.min_occurrences ?? 1;
  const filter = opts.payees ? new Set(opts.payees) : null;
  // Disabled rules do not participate in resolution and must not permanently
  // block a replacement rule with the same exact-match pattern.
  const existingPatterns = new Map(rules.list(false).map((r) => [r.pattern, r]));
  const candidates: SynthesizedCandidate[] = [];

  for (const row of rows) {
    if (filter && !filter.has(row.payee_norm)) continue;
    if (!row.proposed) continue;
    const pattern = exactPattern(row.payee_norm);
    const base = { payee_norm: row.payee_norm, pattern, rate: row.proposed.rate, code: row.proposed.code };
    if (row.status === "match") { candidates.push({ ...base, priority: SHEET_RULE_PRIORITY, action: "skip", reason: "already matches" }); continue; }
    if (row.proposed.occurrences < minOcc) { candidates.push({ ...base, priority: SHEET_RULE_PRIORITY, action: "skip", reason: `occurrences < ${minOcc}` }); continue; }
    const exactExisting = existingPatterns.get(pattern);
    if (exactExisting) {
      if (row.status === "differs" && opts.override) {
        candidates.push({ ...base, priority: exactExisting.priority, action: "update", reason: "update exact pattern", rule_id: exactExisting.id });
      } else {
        candidates.push({ ...base, priority: exactExisting.priority, action: "skip", reason: "pattern exists" });
      }
      continue;
    }
    let priority = SHEET_RULE_PRIORITY;
    if (row.status === "differs") {
      if (!opts.override) { candidates.push({ ...base, priority, action: "skip", reason: "existing rule differs (override not set)" }); continue; }
      const existing = row.current.rule_id === null ? undefined : rules.find(row.current.rule_id);
      if (existing && existing.priority <= 0) {
        candidates.push({ ...base, priority: 0, action: "skip", reason: "existing priority cannot be overridden" });
        continue;
      }
      priority = Math.min(priority, (existing?.priority ?? priority) - 1);
    }
    candidates.push({ ...base, priority, action: "create", reason: row.status });
  }

  let created = 0;
  let updated = 0;
  if (!opts.dry_run) {
    for (const c of candidates) {
      if (c.action === "create") {
        c.rule_id = rules.insert({ pattern: c.pattern, rate: c.rate, code: c.code, priority: c.priority, note: `sheet:${today}` });
        created++;
      } else if (c.action === "update" && c.rule_id !== undefined) {
        rules.update(c.rule_id, { rate: c.rate, code: c.code, note: `sheet:${today}` });
        updated++;
      }
    }
  }
  return { dry_run: opts.dry_run, candidates, created, updated };
}
