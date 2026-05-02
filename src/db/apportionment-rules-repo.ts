import type Database from "better-sqlite3";
import { SEED_RULES, matchRule } from "./seed.js";
import { normalizePayee } from "../shared/text.js";

export interface ApportionmentRuleRow {
  id: number;
  pattern: string;
  rate: number;
  code: number;
  priority: number;
  enabled: number;        // 0/1
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateRuleInput {
  pattern: string;
  rate: number;
  code: number;
  priority?: number;
  enabled?: boolean;
  note?: string | null;
}

export interface ResolvedApportionment {
  rate: number;
  code: number;
  rule_id: number | null;     // null なら fallback (未マッチ → 0% / 124 事業主貸)
}

export class ApportionmentRulesRepo {
  constructor(private readonly db: Database.Database) {}

  list(includeDisabled = false): ApportionmentRuleRow[] {
    const sql = includeDisabled
      ? `SELECT * FROM apportionment_rules ORDER BY priority ASC, id ASC`
      : `SELECT * FROM apportionment_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC`;
    return this.db.prepare(sql).all() as ApportionmentRuleRow[];
  }

  find(id: number): ApportionmentRuleRow | undefined {
    return this.db.prepare(`SELECT * FROM apportionment_rules WHERE id = ?`).get(id) as
      | ApportionmentRuleRow
      | undefined;
  }

  insert(input: CreateRuleInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO apportionment_rules
         (pattern, rate, code, priority, enabled, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.pattern,
        input.rate,
        input.code,
        input.priority ?? 100,
        input.enabled === false ? 0 : 1,
        input.note ?? null,
        now,
        now,
      );
    return Number(r.lastInsertRowid);
  }

  update(id: number, patch: Partial<CreateRuleInput>): boolean {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.pattern !== undefined) { sets.push("pattern = ?"); args.push(patch.pattern); }
    if (patch.rate !== undefined) { sets.push("rate = ?"); args.push(patch.rate); }
    if (patch.code !== undefined) { sets.push("code = ?"); args.push(patch.code); }
    if (patch.priority !== undefined) { sets.push("priority = ?"); args.push(patch.priority); }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); args.push(patch.enabled ? 1 : 0); }
    if (patch.note !== undefined) { sets.push("note = ?"); args.push(patch.note); }
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    args.push(Math.floor(Date.now() / 1000));
    args.push(id);
    const r = this.db
      .prepare(`UPDATE apportionment_rules SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM apportionment_rules WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /**
   * payee 文字列 → {rate, code, rule_id}。
   * 未マッチ時は rate=0, code=124 (事業主貸) で rule_id=null。
   */
  resolve(payee: string | null | undefined): ResolvedApportionment {
    const normalized = normalizePayee(payee);
    if (!normalized) return fallback();
    const rules = this.list(false); // enabled のみ、 priority asc
    const m = matchRule(rules, normalized);
    if (m) return { rate: m.rate, code: m.code, rule_id: m.id };
    return fallback();
  }

  /** apportionment_rules が空のとき seed する */
  seedIfEmpty(): boolean {
    const c = this.db.prepare(`SELECT COUNT(*) AS c FROM apportionment_rules`).get() as { c: number };
    if (c.c > 0) return false;
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(
      `INSERT INTO apportionment_rules (pattern, rate, code, priority, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const r of SEED_RULES) stmt.run(r.pattern, r.rate, r.code, r.priority, r.note ?? null, now, now);
    })();
    return true;
  }
}

function fallback(): ResolvedApportionment {
  // 124: 事業主貸 (家計支出として処理)
  return { rate: 0, code: 124, rule_id: null };
}
