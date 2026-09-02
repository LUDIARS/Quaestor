/**
 * 家計分析。 支出イベントを 期間 (週/月/3ヶ月/6ヶ月/1年) で切り、
 * 費目別 / 場所別 / 地点別 / 決済手段別 / 日別 に集計して前期間と比べる。
 *
 * 各イベントは按分ルールで 事業分 (amount × rate) と 家計分 (残り) に割れる。
 * 費目別は家計分だけを household_category に振り、 事業分は擬似費目「事業経費」(id 0) にまとめる。
 * これで費目別の合計 = 支出合計 になる。
 *
 * @implements SPEC-HOUSEHOLD-ANALYSIS-002 (spec/feature/household-bookkeeping.md)
 */

import type Database from "better-sqlite3";
import type { ApportionmentRulesRepo } from "../../db/apportionment-rules-repo.js";
import { dataCoverage, type DataCoverage } from "../behavior-analysis.js";
import type { HouseholdClassifier } from "./household-classifier.js";
import { enumerateDays, resolveWindow, type AnalysisWindow, type ResolvedWindow } from "./analysis-windows.js";
import { collectSpendEvents, type SpendEvent } from "./spend-events.js";

export interface HouseholdAnalysisDeps {
  db: Database.Database;
  rules: ApportionmentRulesRepo;
  classifier: HouseholdClassifier;
}

export interface SpendTotals {
  spend: number;
  household: number;
  business: number;
  count: number;
}

export interface CategoryBreakdown {
  category_id: number;
  name: string;
  current: number;
  previous: number;
  delta: number;
  /** 期間内支出合計に対する割合 (0..1) */
  share: number;
  count: number;
}

export interface PlaceBreakdown {
  payee_norm: string;
  payee_sample: string;
  amount: number;
  count: number;
  household: number;
  business: number;
  previous: number;
  category_name: string;
  receipt_linked: number;
}

export interface LocationBreakdown {
  lat: number;
  lon: number;
  amount: number;
  count: number;
  payees: string[];
}

export interface MethodBreakdown {
  method: string;
  amount: number;
  count: number;
}

export interface DailyPoint {
  date: string;
  amount: number;
}

export interface HouseholdAnalysis {
  window: ResolvedWindow;
  coverage: DataCoverage;
  totals: { current: SpendTotals; previous: SpendTotals; delta: number };
  by_category: CategoryBreakdown[];
  by_place: PlaceBreakdown[];
  by_location: LocationBreakdown[];
  by_method: MethodBreakdown[];
  daily: DailyPoint[];
  receipt_link: { events: number; with_receipt: number; rate: number };
}

export const BUSINESS_PSEUDO_CATEGORY = { id: 0, name: "事業経費" } as const;

/** GPS を約 100 m 格子に丸める (小数第 3 位)。 */
export function gridKey(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

interface SplitEvent extends SpendEvent {
  business: number;
  household: number;
  category_id: number;
  category_name: string;
}

function splitEvents(deps: HouseholdAnalysisDeps, events: SpendEvent[]): SplitEvent[] {
  return events.map((e) => {
    const { rate } = deps.rules.resolve(e.payee);
    const business = Math.round(e.amount * rate);
    const household = e.amount - business;
    const cls = household > 0 ? deps.classifier.classify(e.payee) : null;
    return {
      ...e,
      business,
      household,
      category_id: cls?.category_id ?? BUSINESS_PSEUDO_CATEGORY.id,
      category_name: cls?.category_name ?? BUSINESS_PSEUDO_CATEGORY.name,
    };
  });
}

function totalsOf(events: SplitEvent[]): SpendTotals {
  return events.reduce<SpendTotals>((t, e) => ({
    spend: t.spend + e.amount, household: t.household + e.household, business: t.business + e.business, count: t.count + 1,
  }), { spend: 0, household: 0, business: 0, count: 0 });
}

function categoryTotals(events: SplitEvent[]): Map<number, { name: string; amount: number; count: number }> {
  const m = new Map<number, { name: string; amount: number; count: number }>();
  const bump = (id: number, name: string, amount: number, countOnce: boolean) => {
    if (amount <= 0) return;
    const cur = m.get(id) ?? { name, amount: 0, count: 0 };
    cur.amount += amount;
    if (countOnce) cur.count += 1;
    m.set(id, cur);
  };
  for (const e of events) {
    bump(e.category_id, e.category_name, e.household, true);
    bump(BUSINESS_PSEUDO_CATEGORY.id, BUSINESS_PSEUDO_CATEGORY.name, e.business, e.household === 0);
  }
  return m;
}

function placeTotals(events: SplitEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.payee_norm, (m.get(e.payee_norm) ?? 0) + e.amount);
  return m;
}

export function analyzeHousehold(
  deps: HouseholdAnalysisDeps,
  window: AnalysisWindow,
  anchor: string,
  opts: { top_places?: number; top_locations?: number } = {},
): HouseholdAnalysis {
  const resolved = resolveWindow(window, anchor);
  const current = splitEvents(deps, collectSpendEvents(deps.db, resolved.current));
  const previous = splitEvents(deps, collectSpendEvents(deps.db, resolved.previous));

  const curTotals = totalsOf(current);
  const prevTotals = totalsOf(previous);

  const curCat = categoryTotals(current);
  const prevCat = categoryTotals(previous);
  const byCategory: CategoryBreakdown[] = [...new Set([...curCat.keys(), ...prevCat.keys()])]
    .map((id) => {
      const c = curCat.get(id);
      const p = prevCat.get(id);
      const cur = c?.amount ?? 0;
      const prev = p?.amount ?? 0;
      return {
        category_id: id,
        name: c?.name ?? p?.name ?? "",
        current: cur,
        previous: prev,
        delta: cur - prev,
        share: curTotals.spend > 0 ? cur / curTotals.spend : 0,
        count: c?.count ?? 0,
      };
    })
    .sort((a, b) => b.current - a.current || b.previous - a.previous);

  const prevPlace = placeTotals(previous);
  const placeAcc = new Map<string, PlaceBreakdown>();
  for (const e of current) {
    let p = placeAcc.get(e.payee_norm);
    if (!p) {
      p = { payee_norm: e.payee_norm, payee_sample: e.payee, amount: 0, count: 0, household: 0, business: 0,
        previous: prevPlace.get(e.payee_norm) ?? 0, category_name: e.category_name, receipt_linked: 0 };
      placeAcc.set(e.payee_norm, p);
    }
    p.amount += e.amount;
    p.count += 1;
    p.household += e.household;
    p.business += e.business;
    if (e.receipt_id) p.receipt_linked += 1;
  }
  const byPlace = [...placeAcc.values()]
    .sort((a, b) => b.amount - a.amount || b.count - a.count)
    .slice(0, opts.top_places ?? 30);

  const locAcc = new Map<string, LocationBreakdown & { payeeSet: Map<string, number> }>();
  for (const e of current) {
    if (!e.geo) continue;
    const g = gridKey(e.geo.lat, e.geo.lon);
    const key = `${g.lat},${g.lon}`;
    let l = locAcc.get(key);
    if (!l) { l = { lat: g.lat, lon: g.lon, amount: 0, count: 0, payees: [], payeeSet: new Map() }; locAcc.set(key, l); }
    l.amount += e.amount;
    l.count += 1;
    l.payeeSet.set(e.payee, (l.payeeSet.get(e.payee) ?? 0) + e.amount);
  }
  const byLocation: LocationBreakdown[] = [...locAcc.values()]
    .map(({ payeeSet, ...rest }) => ({
      ...rest,
      payees: [...payeeSet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p),
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, opts.top_locations ?? 20);

  const methodAcc = new Map<string, MethodBreakdown>();
  for (const e of current) {
    const m = methodAcc.get(e.method) ?? { method: e.method, amount: 0, count: 0 };
    m.amount += e.amount;
    m.count += 1;
    methodAcc.set(e.method, m);
  }
  const byMethod = [...methodAcc.values()].sort((a, b) => b.amount - a.amount);

  const dailyMap = new Map<string, number>();
  for (const e of current) dailyMap.set(e.date, (dailyMap.get(e.date) ?? 0) + e.amount);
  const daily = enumerateDays(resolved.current).map((date) => ({ date, amount: dailyMap.get(date) ?? 0 }));

  const withReceipt = current.filter((e) => e.receipt_id).length;

  return {
    window: resolved,
    coverage: dataCoverage(deps.db),
    totals: { current: curTotals, previous: prevTotals, delta: curTotals.spend - prevTotals.spend },
    by_category: byCategory,
    by_place: byPlace,
    by_location: byLocation,
    by_method: byMethod,
    daily,
    receipt_link: { events: current.length, with_receipt: withReceipt, rate: current.length ? withReceipt / current.length : 0 },
  };
}
