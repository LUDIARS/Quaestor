/**
 * 固定費 / 変動費と水道光熱費の分類ルール台帳 (cost_rules)。
 * @implements SPEC-COST-STRUCTURE-001 (spec/feature/cost-structure.md)
 */

import type Database from "better-sqlite3";
import { matchRule } from "./seed.js";
import { COST_RULE_SEED, type CostType, type UtilityKind } from "./cost-rules-seed.js";
import { normalizePayee } from "../shared/text.js";

export interface CostRuleRow {
  id: number;
  pattern: string;
  cost_type: CostType;
  utility: UtilityKind | null;
  label: string | null;
  priority: number;
  enabled: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateCostRuleInput {
  pattern: string;
  cost_type: CostType;
  utility?: UtilityKind | null;
  label?: string | null;
  priority?: number;
  enabled?: boolean;
  note?: string | null;
}

export type UpdateCostRuleInput = Partial<CreateCostRuleInput>;

export interface ResolvedCost {
  cost_type: CostType;
  utility: UtilityKind | null;
  label: string | null;
  rule_id: number | null;
}

/**
 * cost_rules の永続化と priority 順の分類解決を担う。
 * @implements SPEC-COST-STRUCTURE-001 (spec/feature/cost-structure.md)
 */
export class CostRulesRepo {
  constructor(private readonly db: Database.Database) {}

  list(includeDisabled = false): CostRuleRow[] {
    const sql = includeDisabled
      ? `SELECT * FROM cost_rules ORDER BY priority ASC, id ASC`
      : `SELECT * FROM cost_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC`;
    return this.db.prepare(sql).all() as CostRuleRow[];
  }

  find(id: number): CostRuleRow | undefined {
    return this.db.prepare(`SELECT * FROM cost_rules WHERE id = ?`).get(id) as CostRuleRow | undefined;
  }

  findByPattern(pattern: string): CostRuleRow | undefined {
    return this.db.prepare(`SELECT * FROM cost_rules WHERE pattern = ?`).get(pattern) as CostRuleRow | undefined;
  }

  insert(input: CreateCostRuleInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO cost_rules (pattern, cost_type, utility, label, priority, enabled, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.pattern, input.cost_type, input.utility ?? null, input.label ?? null, input.priority ?? 100,
        input.enabled === false ? 0 : 1, input.note ?? null, now, now);
    return Number(r.lastInsertRowid);
  }

  update(id: number, input: UpdateCostRuleInput): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, v: unknown) => { sets.push(`${col} = ?`); params.push(v); };
    if (input.pattern !== undefined) push("pattern", input.pattern);
    if (input.cost_type !== undefined) push("cost_type", input.cost_type);
    if (input.utility !== undefined) push("utility", input.utility);
    if (input.label !== undefined) push("label", input.label);
    if (input.priority !== undefined) push("priority", input.priority);
    if (input.enabled !== undefined) push("enabled", input.enabled ? 1 : 0);
    if (input.note !== undefined) push("note", input.note);
    if (sets.length === 0) return this.find(id) !== undefined;
    push("updated_at", Math.floor(Date.now() / 1000));
    params.push(id);
    return this.db.prepare(`UPDATE cost_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes > 0;
  }

  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM cost_rules WHERE id = ?`).run(id).changes > 0;
  }

  /** enabled ルールを priority 順に試す。 未マッチは variable。 */
  resolve(payee: string | null | undefined): ResolvedCost {
    const normalized = normalizePayee(payee);
    if (!normalized) return { cost_type: "variable", utility: null, label: null, rule_id: null };
    const m = matchRule(this.list(false), normalized);
    if (!m) return { cost_type: "variable", utility: null, label: null, rule_id: null };
    return { cost_type: m.cost_type, utility: m.utility, label: m.label, rule_id: m.id };
  }

  seedIfEmpty(): boolean {
    const c = this.db.prepare(`SELECT COUNT(*) AS c FROM cost_rules`).get() as { c: number };
    if (c.c > 0) return false;
    this.db.transaction(() => {
      for (const s of COST_RULE_SEED) this.insert({ pattern: s.pattern, cost_type: s.cost_type, utility: s.utility ?? null, label: s.label, priority: s.priority, note: "seed" });
    })();
    return true;
  }
}
