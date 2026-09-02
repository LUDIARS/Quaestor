/**
 * 年度の減価償却表 (エクセル簿記 ③ の全行 + 合計)。 台帳を読み、 各資産を投影して該当年の行を抜く。
 * @implements SPEC-DEPRECIATION-002 (spec/feature/depreciation.md)
 */

import type { FixedAssetRow, FixedAssetsRepo } from "../../db/fixed-assets-repo.js";
import { depreciationForYear, projectUntilDone, type DepreciationYear } from "./depreciation-calc.js";

export interface ScheduleRow extends DepreciationYear {
  asset_id: number;
  name: string;
  quantity: string | null;
  acquired_on: string;
  cost: number;
  method: FixedAssetRow["method"];
  useful_life: number;
  business_ratio: number;
  asset_code: number;
  expense_code: number;
  notes: string | null;
}

export interface ScheduleTotals {
  ordinary: number;
  extra: number;
  total: number;
  expense: number;
  household: number;
  closing_book: number;
}

export interface YearSchedule {
  year: number;
  rows: ScheduleRow[];
  totals: ScheduleTotals;
}

export class DepreciationSchedule {
  constructor(private readonly assets: FixedAssetsRepo) {}

  forYear(year: number): YearSchedule {
    const rows: ScheduleRow[] = [];
    for (const a of this.assets.list()) {
      const y = depreciationForYear(a, year);
      // 取得前の資産だけを除外し、取得済みの資産は当年の償却額が 0 でも台帳行として残す。
      if (Number(a.acquired_on.slice(0, 4)) > year) continue;
      rows.push({ ...y, ...pickAsset(a) });
    }
    const totals = rows.reduce<ScheduleTotals>((t, r) => ({
      ordinary: t.ordinary + r.ordinary, extra: t.extra + r.extra, total: t.total + r.total,
      expense: t.expense + r.expense, household: t.household + r.household, closing_book: t.closing_book + r.closing_book,
    }), { ordinary: 0, extra: 0, total: 0, expense: 0, household: 0, closing_book: 0 });
    return { year, rows, totals };
  }

  projection(assetId: number): { asset: FixedAssetRow; rows: DepreciationYear[] } | null {
    const a = this.assets.find(assetId);
    if (!a) return null;
    return { asset: a, rows: projectUntilDone(a) };
  }
}

function pickAsset(a: FixedAssetRow) {
  return {
    asset_id: a.id, name: a.name, quantity: a.quantity, acquired_on: a.acquired_on, cost: a.cost, method: a.method,
    useful_life: a.useful_life, business_ratio: a.business_ratio, asset_code: a.asset_code, expense_code: a.expense_code, notes: a.notes,
  };
}
