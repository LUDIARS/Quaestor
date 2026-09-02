/**
 * 水道光熱費スキャン。 utility 付きルールに当たった支出を 月 × 種別 で集計し、 12 ヶ月推移と前年同月比を返す。
 * @implements SPEC-COST-STRUCTURE-004 (spec/feature/cost-structure.md)
 */

import type { UtilityKind } from "../../db/cost-rules-seed.js";
import type { CostRulesRepo } from "../../db/cost-rules-repo.js";
import type { SpendEvent } from "../household/spend-events.js";

export const UTILITY_KINDS: UtilityKind[] = ["electric", "gas", "water"];
export const UTILITY_LABEL: Record<UtilityKind, string> = { electric: "電気", gas: "ガス", water: "水道" };

export interface UtilityMonth {
  month: string;                       // YYYY-MM
  by_kind: Record<UtilityKind, number>;
  total: number;
}

export interface UtilityKindSummary {
  kind: UtilityKind;
  label: string;
  latest_month: string | null;
  latest_amount: number;
  previous_year_amount: number | null;  // 前年同月
  yoy_delta: number | null;
  average_12m: number;
  total_12m: number;
  payees: string[];
}

export interface UtilityScan {
  months: UtilityMonth[];               // 昇順、 anchor 月を末尾とする N ヶ月
  kinds: UtilityKindSummary[];
  total_12m: number;
  events: number;
}

export function monthsEndingAt(anchorMonth: string, n: number): string[] {
  const [y, m] = anchorMonth.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const total = y * 12 + (m - 1) - i;
    out.push(`${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** events は対象期間 + 前年同月比のために 12 ヶ月前まで含めて渡す。 */
export function scanUtilities(events: SpendEvent[], rules: CostRulesRepo, anchorMonth: string, n = 12): UtilityScan {
  const months = monthsEndingAt(anchorMonth, n);
  const displayedMonths = new Set(months);
  const byMonth = new Map<string, Record<UtilityKind, number>>();
  const payeesByKind: Record<UtilityKind, Set<string>> = { electric: new Set(), gas: new Set(), water: new Set() };
  let matched = 0;
  const resolveCache = new Map<string, UtilityKind | null>();
  for (const e of events) {
    let kind = resolveCache.get(e.payee_norm);
    if (kind === undefined) { kind = rules.resolve(e.payee).utility; resolveCache.set(e.payee_norm, kind); }
    if (!kind) continue;
    const month = e.date.slice(0, 7);
    const rec = byMonth.get(month) ?? { electric: 0, gas: 0, water: 0 };
    rec[kind] += e.amount;
    byMonth.set(month, rec);
    // 前年同月比較用に読み込んだイベントは、表示期間の件数・支払先には含めない。
    if (displayedMonths.has(month)) {
      matched++;
      payeesByKind[kind].add(e.payee);
    }
  }

  const series: UtilityMonth[] = months.map((month) => {
    const by_kind = byMonth.get(month) ?? { electric: 0, gas: 0, water: 0 };
    return { month, by_kind, total: by_kind.electric + by_kind.gas + by_kind.water };
  });

  const kinds: UtilityKindSummary[] = UTILITY_KINDS.map((kind) => {
    const withData = [...series].reverse().find((s) => s.by_kind[kind] > 0);
    const latestMonth = withData?.month ?? null;
    const latestAmount = withData?.by_kind[kind] ?? 0;
    let prevYear: number | null = null;
    if (latestMonth) {
      const py = `${Number(latestMonth.slice(0, 4)) - 1}${latestMonth.slice(4)}`;
      const rec = byMonth.get(py);
      prevYear = rec && rec[kind] > 0 ? rec[kind] : null;
    }
    const total = series.reduce((t, s) => t + s.by_kind[kind], 0);
    const nonZero = series.filter((s) => s.by_kind[kind] > 0).length;
    return {
      kind, label: UTILITY_LABEL[kind], latest_month: latestMonth, latest_amount: latestAmount,
      previous_year_amount: prevYear, yoy_delta: prevYear === null ? null : latestAmount - prevYear,
      average_12m: nonZero ? Math.round(total / nonZero) : 0, total_12m: total, payees: [...payeesByKind[kind]].slice(0, 5),
    };
  });

  return { months: series, kinds, total_12m: series.reduce((t, s) => t + s.total, 0), events: matched };
}
