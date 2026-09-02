/**
 * 固定資産台帳 (fixed_assets) の CRUD。 償却計算は services/depreciation 側。
 * @implements SPEC-DEPRECIATION-001 (spec/feature/depreciation.md)
 */

import type Database from "better-sqlite3";
import type { DepreciationMethod } from "../services/depreciation/rate-table.js";

export interface FixedAssetRow {
  id: number;
  name: string;
  quantity: string | null;
  acquired_on: string;
  cost: number;
  method: DepreciationMethod;
  useful_life: number;
  business_ratio: number;
  asset_code: number;
  expense_code: number;
  opening_book_value: number | null;
  opening_year: number | null;
  revised_cost: number | null;
  disposed_on: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateFixedAssetInput {
  name: string;
  quantity?: string | null;
  acquired_on: string;
  cost: number;
  method: DepreciationMethod;
  useful_life?: number;
  business_ratio?: number;
  asset_code?: number;
  expense_code?: number;
  opening_book_value?: number | null;
  opening_year?: number | null;
  revised_cost?: number | null;
  disposed_on?: string | null;
  notes?: string | null;
}

export type UpdateFixedAssetInput = Partial<CreateFixedAssetInput>;

export const DEFAULT_ASSET_CODE = 115;   // 備品
export const DEFAULT_EXPENSE_CODE = 18;  // 減価償却費

const COLUMNS: (keyof CreateFixedAssetInput)[] = [
  "name", "quantity", "acquired_on", "cost", "method", "useful_life", "business_ratio", "asset_code", "expense_code",
  "opening_book_value", "opening_year", "revised_cost", "disposed_on", "notes",
];

export class FixedAssetsRepo {
  constructor(private readonly db: Database.Database) {}

  list(): FixedAssetRow[] {
    return this.db.prepare(`SELECT * FROM fixed_assets ORDER BY acquired_on ASC, id ASC`).all() as FixedAssetRow[];
  }

  find(id: number): FixedAssetRow | undefined {
    return this.db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id) as FixedAssetRow | undefined;
  }

  insert(input: CreateFixedAssetInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO fixed_assets
           (name, quantity, acquired_on, cost, method, useful_life, business_ratio, asset_code, expense_code,
            opening_book_value, opening_year, revised_cost, disposed_on, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name, input.quantity ?? null, input.acquired_on, input.cost, input.method,
        input.useful_life ?? 0, input.business_ratio ?? 1, input.asset_code ?? DEFAULT_ASSET_CODE, input.expense_code ?? DEFAULT_EXPENSE_CODE,
        input.opening_book_value ?? null, input.opening_year ?? null, input.revised_cost ?? null,
        input.disposed_on ?? null, input.notes ?? null, now, now,
      );
    return Number(r.lastInsertRowid);
  }

  update(id: number, input: UpdateFixedAssetInput): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const col of COLUMNS) {
      if (input[col] === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(input[col]);
    }
    if (sets.length === 0) return this.find(id) !== undefined;
    sets.push("updated_at = ?");
    params.push(Math.floor(Date.now() / 1000), id);
    return this.db.prepare(`UPDATE fixed_assets SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes > 0;
  }

  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM fixed_assets WHERE id = ?`).run(id).changes > 0;
  }
}
