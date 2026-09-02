import type Database from "better-sqlite3";
import { matchRule } from "./seed.js";
import { HOUSEHOLD_RULE_SEED } from "./household-seed.js";
import { normalizePayee } from "../shared/text.js";
import type { HouseholdCategoriesRepo } from "./household-categories-repo.js";

export interface HouseholdRuleRow {
  id: number;
  pattern: string;
  category_id: number;
  priority: number;
  enabled: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateHouseholdRuleInput {
  pattern: string;
  category_id: number;
  priority?: number;
  enabled?: boolean;
  note?: string | null;
}

export type UpdateHouseholdRuleInput = Partial<CreateHouseholdRuleInput>;

/**
 * payee pattern → 家計費目 のルール台帳。 解決順序は apportionment_rules と同じ (priority asc)。
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-002 (spec/feature/household-bookkeeping.md)
 */
export class HouseholdRulesRepo {
  constructor(private readonly db: Database.Database) {}

  list(includeDisabled = false): HouseholdRuleRow[] {
    const sql = includeDisabled
      ? `SELECT * FROM household_rules ORDER BY priority ASC, id ASC`
      : `SELECT * FROM household_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC`;
    return this.db.prepare(sql).all() as HouseholdRuleRow[];
  }

  find(id: number): HouseholdRuleRow | undefined {
    return this.db.prepare(`SELECT * FROM household_rules WHERE id = ?`).get(id) as HouseholdRuleRow | undefined;
  }

  insert(input: CreateHouseholdRuleInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO household_rules (pattern, category_id, priority, enabled, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.pattern, input.category_id, input.priority ?? 100, input.enabled === false ? 0 : 1, input.note ?? null, now, now);
    return Number(r.lastInsertRowid);
  }

  update(id: number, input: UpdateHouseholdRuleInput): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.pattern !== undefined) { sets.push("pattern = ?"); params.push(input.pattern); }
    if (input.category_id !== undefined) { sets.push("category_id = ?"); params.push(input.category_id); }
    if (input.priority !== undefined) { sets.push("priority = ?"); params.push(input.priority); }
    if (input.enabled !== undefined) { sets.push("enabled = ?"); params.push(input.enabled ? 1 : 0); }
    if (input.note !== undefined) { sets.push("note = ?"); params.push(input.note); }
    if (sets.length === 0) return this.find(id) !== undefined;
    sets.push("updated_at = ?");
    params.push(Math.floor(Date.now() / 1000), id);
    const r = this.db.prepare(`UPDATE household_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM household_rules WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /** enabled ルールを priority 順に試し、 最初に当たった category_id を返す。 未マッチは null。 */
  resolve(payee: string | null | undefined): { category_id: number; rule_id: number } | null {
    const normalized = normalizePayee(payee);
    if (!normalized) return null;
    const m = matchRule(this.list(false), normalized);
    return m ? { category_id: m.category_id, rule_id: m.id } : null;
  }

  /** ルール表が空のときだけ seed する (費目名 → id は categories から引く)。 */
  seedIfEmpty(categories: HouseholdCategoriesRepo): boolean {
    const c = this.db.prepare(`SELECT COUNT(*) AS c FROM household_rules`).get() as { c: number };
    if (c.c > 0) return false;
    this.db.transaction(() => {
      for (const s of HOUSEHOLD_RULE_SEED) {
        const cat = categories.findByName(s.category);
        if (!cat) continue;
        this.insert({ pattern: s.pattern, category_id: cat.id, priority: s.priority, note: s.note ?? null });
      }
    })();
    return true;
  }
}
