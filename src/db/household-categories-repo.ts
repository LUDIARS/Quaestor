import type Database from "better-sqlite3";
import { HOUSEHOLD_CATEGORY_SEED, HOUSEHOLD_FALLBACK_CATEGORY } from "./household-seed.js";

export interface HouseholdCategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  display_order: number;
  created_at: number;
}

export interface CreateCategoryInput {
  name: string;
  parent_id?: number | null;
  display_order?: number;
}

export type UpdateCategoryInput = Partial<CreateCategoryInput>;

/**
 * 家計費目の CRUD。 seed と「その他」フォールバックの解決を担う。
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-002 (spec/feature/household-bookkeeping.md)
 */
export class HouseholdCategoriesRepo {
  constructor(private readonly db: Database.Database) {}

  list(): HouseholdCategoryRow[] {
    return this.db
      .prepare(`SELECT * FROM household_categories ORDER BY display_order ASC, id ASC`)
      .all() as HouseholdCategoryRow[];
  }

  find(id: number): HouseholdCategoryRow | undefined {
    return this.db.prepare(`SELECT * FROM household_categories WHERE id = ?`).get(id) as HouseholdCategoryRow | undefined;
  }

  findByName(name: string): HouseholdCategoryRow | undefined {
    return this.db.prepare(`SELECT * FROM household_categories WHERE name = ?`).get(name) as HouseholdCategoryRow | undefined;
  }

  insert(input: CreateCategoryInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO household_categories (name, parent_id, display_order, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.name, input.parent_id ?? null, input.display_order ?? 0, now);
    return Number(r.lastInsertRowid);
  }

  update(id: number, input: UpdateCategoryInput): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
    if (input.parent_id !== undefined) { sets.push("parent_id = ?"); params.push(input.parent_id); }
    if (input.display_order !== undefined) { sets.push("display_order = ?"); params.push(input.display_order); }
    if (sets.length === 0) return this.find(id) !== undefined;
    params.push(id);
    const r = this.db.prepare(`UPDATE household_categories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM household_categories WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /** 「その他」の id。 seed 済みなら必ず存在する。 無ければ作る (fail-safe ではなく整合性維持)。 */
  fallbackId(): number {
    const row = this.findByName(HOUSEHOLD_FALLBACK_CATEGORY);
    if (row) return row.id;
    return this.insert({ name: HOUSEHOLD_FALLBACK_CATEGORY, display_order: 999 });
  }

  /** 名前が無いものだけ seed する (再実行しても増えない)。 戻り値は追加件数。 */
  seedMissing(): number {
    let added = 0;
    this.db.transaction(() => {
      for (const s of HOUSEHOLD_CATEGORY_SEED) {
        if (this.findByName(s.name)) continue;
        const parent = s.parent ? this.findByName(s.parent) : undefined;
        this.insert({ name: s.name, parent_id: parent?.id ?? null, display_order: s.order });
        added++;
      }
    })();
    return added;
  }
}
