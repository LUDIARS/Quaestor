/**
 * 償却率表と償却法 family の解決。
 *
 * family:
 *   old_sl / old_db — 2007-03-31 以前取得 (旧定額 / 旧定率、 残存 10%、 5% 到達後 5 年均等)
 *   sl              — 2007-04-01 以後取得の定額 (備忘価額 1 円)
 *   db250           — 2007-04-01〜2012-03-31 取得の定率 (250%、 改定償却率 / 保証率)
 *   db200           — 2012-04-01 以後取得の定率 (200%)
 * 旧定額 / 旧定率 / 定額 / 250% は calc/2025.xlsx (エクセル簿記 ③ EB8:EH56) から抽出。
 * 200% は国税庁 別表第十 の転記 (spec/plan/2026-09-03-depreciation.md 参照、 実データ照合が要る)。
 *
 * @implements SPEC-DEPRECIATION-001 (spec/feature/depreciation.md)
 */

import rates from "./rates.json" with { type: "json" };

export const DEPRECIATION_METHODS = [
  "straight_line", "declining_balance", "old_straight_line", "old_declining_balance", "lump_sum_3y", "immediate",
] as const;

export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export type RateFamily = "old_sl" | "old_db" | "sl" | "db250" | "db200";

export interface RateRow {
  useful_life: number;
  old_sl: number;
  old_db: number;
  sl: number;
  db250: number;
  db250_revised: number | null;
  db250_guarantee: number | null;
  db200: number;
  db200_revised: number | null;
  db200_guarantee: number | null;
}

export interface ResolvedRate {
  family: RateFamily;
  rate: number;
  revised_rate: number | null;
  guarantee_rate: number | null;
}

/** 新法 (定額 1 円備忘 / 250% 定率) の境 */
export const NEW_LAW_FROM = "2007-04-01";
/** 200% 定率の境 */
export const DB200_FROM = "2012-04-01";

const TABLE: RateRow[] = rates as RateRow[];

export function rateTable(): RateRow[] {
  return TABLE;
}

export function rateRow(usefulLife: number): RateRow | null {
  return TABLE.find((r) => r.useful_life === usefulLife) ?? null;
}

/** 取得日と方法から family を決める。 旧法指定でも取得日が新法域なら新法に寄せる (エクセル簿記 DD 列と同じ)。 */
export function resolveFamily(method: DepreciationMethod, acquiredOn: string): RateFamily | null {
  const isNew = acquiredOn >= NEW_LAW_FROM;
  switch (method) {
    case "straight_line":
    case "old_straight_line":
      return isNew ? "sl" : "old_sl";
    case "declining_balance":
    case "old_declining_balance":
      if (!isNew) return "old_db";
      return acquiredOn >= DB200_FROM ? "db200" : "db250";
    default:
      return null; // lump_sum_3y / immediate は率を使わない
  }
}

export function resolveRate(family: RateFamily, usefulLife: number): ResolvedRate | null {
  const row = rateRow(usefulLife);
  if (!row) return null;
  switch (family) {
    case "old_sl": return { family, rate: row.old_sl, revised_rate: null, guarantee_rate: null };
    case "old_db": return { family, rate: row.old_db, revised_rate: null, guarantee_rate: null };
    case "sl": return { family, rate: row.sl, revised_rate: null, guarantee_rate: null };
    case "db250": return { family, rate: row.db250, revised_rate: row.db250_revised, guarantee_rate: row.db250_guarantee };
    case "db200": return { family, rate: row.db200, revised_rate: row.db200_revised, guarantee_rate: row.db200_guarantee };
  }
}
