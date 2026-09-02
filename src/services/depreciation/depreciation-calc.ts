/**
 * 減価償却の計算 (エクセル簿記 ③ の R / U / X / Z 列)。 純関数。
 *
 * 1 資産を取得年から年ごとに投影し、 期首簿価と改定取得価額を繰り越す。
 * 規則は spec/plan/2026-09-03-depreciation.md §4 (定額 / 定率 (250%・200%) / 旧定額 / 旧定率 / 一括 3 年 / 即時)。
 *
 * @implements SPEC-DEPRECIATION-002 (spec/feature/depreciation.md)
 */

import { resolveFamily, resolveRate, type DepreciationMethod, type RateFamily } from "./rate-table.js";

export interface DepreciableAsset {
  acquired_on: string;           // ISO yyyy-mm-dd
  cost: number;
  method: DepreciationMethod;
  useful_life: number;
  business_ratio: number;        // 0..1
  /** 台帳に載せた時点の期首簿価とその年 (エクセル簿記 AC 列)。 null なら取得年から計算 */
  opening_book_value?: number | null;
  opening_year?: number | null;
  /** 改定取得価額 (定率の切替時の簿価)。 null なら計算で求める */
  revised_cost?: number | null;
  disposed_on?: string | null;
}

export interface DepreciationYear {
  year: number;
  months: number;                // 本年中の償却期間 (ニ)
  opening_book: number;          // 期首簿価
  basis: number;                 // 償却の基礎 (ロ)
  rate: number;                  // 償却率 (ハ)
  family: RateFamily | null;
  revised: boolean;              // 改定償却率で計算した年か
  ordinary: number;              // 普通償却費 (ホ)
  extra: number;                 // 割増償却費 (ヘ)、 今回は 0
  total: number;                 // 合計 (ト)
  expense: number;               // 必要経費算入額 (リ)
  household: number;             // 家計分 = 合計 − 経費算入額
  closing_book: number;          // 未償却残高 (ヌ)
  /** その年に改定取得価額を確定した場合の値 (繰越用) */
  revised_cost: number | null;
}

export const MEMO_VALUE = 1;

function yearOf(iso: string): number { return Number(iso.slice(0, 4)); }
function monthOf(iso: string): number { return Number(iso.slice(5, 7)); }

/** 本年中の償却期間 (月)。 取得前 / 除却後は 0。 */
export function monthsInYear(asset: Pick<DepreciableAsset, "acquired_on" | "disposed_on">, year: number): number {
  const ay = yearOf(asset.acquired_on);
  if (year < ay) return 0;
  let from = 1;
  let to = 12;
  if (year === ay) from = monthOf(asset.acquired_on);
  if (asset.disposed_on) {
    const dy = yearOf(asset.disposed_on);
    if (year > dy) return 0;
    if (year === dy) to = monthOf(asset.disposed_on);
  }
  return Math.max(0, to - from + 1);
}

interface State {
  opening: number;
  revisedCost: number | null;
}

function roundHalfUp(n: number): number {
  return Math.round(n);
}

function computeOne(asset: DepreciableAsset, year: number, state: State): DepreciationYear {
  const months = monthsInYear(asset, year);
  const opening = state.opening;
  const base: DepreciationYear = {
    year, months, opening_book: opening, basis: 0, rate: 0, family: null, revised: false,
    ordinary: 0, extra: 0, total: 0, expense: 0, household: 0, closing_book: opening, revised_cost: state.revisedCost,
  };
  if (months === 0 || opening <= 0) return base;

  let ordinary = 0;
  if (asset.method === "immediate") {
    base.basis = asset.cost;
    base.rate = 1;
    ordinary = year === yearOf(asset.acquired_on) ? opening : 0;
  } else if (asset.method === "lump_sum_3y") {
    base.basis = asset.cost;
    base.rate = 1 / 3;
    const ay = yearOf(asset.acquired_on);
    if (year >= ay && year <= ay + 2) ordinary = year === ay + 2 ? opening : Math.min(opening, roundHalfUp(asset.cost / 3));
  } else {
    const family = resolveFamily(asset.method, asset.acquired_on);
    const resolved = family ? resolveRate(family, asset.useful_life) : null;
    if (!family || !resolved) throw new Error(`rate not found: ${asset.method} / ${asset.useful_life} years`);
    base.family = family;
    if (opening <= MEMO_VALUE) return base;

    if (family === "sl") {
      base.basis = asset.cost;
      base.rate = resolved.rate;
      const calc = roundHalfUp(asset.cost * resolved.rate * months / 12);
      ordinary = calc >= opening ? opening - MEMO_VALUE : calc;
    } else if (family === "db250" || family === "db200") {
      const guarantee = roundHalfUp(asset.cost * (resolved.guarantee_rate ?? 0));
      const normal = opening * resolved.rate;
      let revisedCost = state.revisedCost;
      if (revisedCost === null && resolved.revised_rate !== null && normal < guarantee && guarantee > 0) {
        revisedCost = opening;
      }
      if (revisedCost !== null && resolved.revised_rate !== null) {
        base.basis = revisedCost;
        base.rate = resolved.revised_rate;
        base.revised = true;
        base.revised_cost = revisedCost;
        ordinary = roundHalfUp(revisedCost * resolved.revised_rate * months / 12);
      } else {
        base.basis = opening;
        base.rate = resolved.rate;
        ordinary = roundHalfUp(normal * months / 12);
      }
      if (ordinary >= opening) ordinary = opening - MEMO_VALUE;
    } else {
      // 旧定額 / 旧定率: 5% 価額まで償却し、 その後 (5% − 1) ÷ 5 を 5 年均等
      const five = roundHalfUp(asset.cost * 0.05);
      base.basis = family === "old_sl" ? roundHalfUp(asset.cost * 0.9) : opening;
      base.rate = resolved.rate;
      if (opening > five) {
        const calc = roundHalfUp(base.basis * resolved.rate * months / 12);
        ordinary = Math.min(calc, opening - five);
      } else {
        const equal = Math.ceil((five - MEMO_VALUE) / 5);
        ordinary = Math.min(equal, opening - MEMO_VALUE);
      }
    }
  }

  ordinary = Math.max(0, ordinary);
  const total = ordinary + base.extra;
  const expense = roundHalfUp(total * asset.business_ratio);
  return {
    ...base,
    ordinary,
    total,
    expense,
    household: total - expense,
    closing_book: opening - total,
  };
}

/** 取得年 (または opening_year) から toYear までを投影する。 */
export function projectDepreciation(asset: DepreciableAsset, toYear: number): DepreciationYear[] {
  const startYear = asset.opening_year ?? yearOf(asset.acquired_on);
  const state: State = {
    opening: asset.opening_year != null && asset.opening_book_value != null ? asset.opening_book_value : asset.cost,
    revisedCost: asset.revised_cost ?? null,
  };
  const out: DepreciationYear[] = [];
  for (let y = startYear; y <= toYear; y++) {
    const row = computeOne(asset, y, state);
    out.push(row);
    state.opening = row.closing_book;
    state.revisedCost = row.revised_cost;
  }
  return out;
}

/** 特定年の 1 行 (それ以前の年を内部で投影して期首簿価を出す)。 */
export function depreciationForYear(asset: DepreciableAsset, year: number): DepreciationYear {
  const rows = projectDepreciation(asset, year);
  const last = rows[rows.length - 1];
  if (!last || last.year !== year) {
    return { year, months: 0, opening_book: 0, basis: 0, rate: 0, family: null, revised: false, ordinary: 0, extra: 0, total: 0, expense: 0, household: 0, closing_book: 0, revised_cost: null };
  }
  return last;
}

/** 完了 (簿価が備忘価額以下) までの投影。 上限は 60 年 (無限ループ防止)。 */
export function projectUntilDone(asset: DepreciableAsset): DepreciationYear[] {
  const startYear = asset.opening_year ?? yearOf(asset.acquired_on);
  const rows = projectDepreciation(asset, startYear + 60);
  const idx = rows.findIndex((r) => r.closing_book <= MEMO_VALUE || (asset.disposed_on != null && r.year >= yearOf(asset.disposed_on)));
  return idx >= 0 ? rows.slice(0, idx + 1) : rows;
}
