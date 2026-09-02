/**
 * 固定費 / 変動費ビュー。 window の支出を cost_rules で分類し、 合計・店別 (月次系列付き)・前期間比・事業分 を返す。
 * 固定費候補の提案 (recurring-detector) と水道光熱費スキャン (utility-scan) の入口もここ。
 * @implements SPEC-COST-STRUCTURE-004 (spec/feature/cost-structure.md)
 */

import type Database from "better-sqlite3";
import type { ApportionmentRulesRepo } from "../../db/apportionment-rules-repo.js";
import type { CostRulesRepo, ResolvedCost } from "../../db/cost-rules-repo.js";
import type { CostType, UtilityKind } from "../../db/cost-rules-seed.js";
import { resolveWindow, type AnalysisWindow, type DateRange, type ResolvedWindow } from "../household/analysis-windows.js";
import { collectSpendEvents, type SpendEvent } from "../household/spend-events.js";
import { collectJournalSpendEvents, monthsWithTransactions } from "./journal-spend-events.js";
import { detectRecurring, type MonthlyPayeeSpend, type RecurringCandidate } from "./recurring-detector.js";
import { monthsEndingAt, scanUtilities, type UtilityScan } from "./utility-scan.js";

export interface CostStructureDeps {
  db: Database.Database;
  rules: CostRulesRepo;
  apportionment: ApportionmentRulesRepo;
}

export interface CostPayeeRow {
  payee_norm: string;
  payee_sample: string;
  cost_type: CostType;
  utility: UtilityKind | null;
  label: string | null;
  rule_id: number | null;
  amount: number;
  count: number;
  business: number;
  previous: number;
  /** window 内の月別 (昇順) */
  monthly: { month: string; amount: number }[];
}

export interface CostTypeTotals {
  amount: number;
  count: number;
  business: number;
  previous: number;
  share: number;
}

export interface CostStructureView {
  window: ResolvedWindow;
  totals: { fixed: CostTypeTotals; variable: CostTypeTotals; spend: number; previous_spend: number };
  fixed: CostPayeeRow[];
  variable: CostPayeeRow[];
  months: string[];
  events: number;
  journal_months_used: string[];
}

/** 取引 + レシート + (取引の無い月だけ) 取込済み仕訳 */
export function collectAllSpend(db: Database.Database, range: DateRange): { events: SpendEvent[]; journalMonths: string[] } {
  const base = collectSpendEvents(db, range);
  const txMonths = monthsWithTransactions(db, range);
  const journal = collectJournalSpendEvents(db, range, txMonths);
  const journalMonths = [...new Set(journal.map((e) => e.date.slice(0, 7)))].sort();
  return { events: [...base, ...journal].sort((a, b) => a.date.localeCompare(b.date)), journalMonths };
}

function monthsOf(range: DateRange): string[] {
  const from = range.from.slice(0, 7);
  const to = range.to.slice(0, 7);
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  const n = (ty * 12 + tm) - (fy * 12 + fm) + 1;
  return monthsEndingAt(to, Math.max(n, 1));
}

export class CostStructureService {
  constructor(private readonly deps: CostStructureDeps) {}

  private classify(cache: Map<string, ResolvedCost>, e: SpendEvent): ResolvedCost {
    let r = cache.get(e.payee_norm);
    if (!r) { r = this.deps.rules.resolve(e.payee); cache.set(e.payee_norm, r); }
    return r;
  }

  view(window: AnalysisWindow, anchor: string): CostStructureView {
    const resolved = resolveWindow(window, anchor);
    const cur = collectAllSpend(this.deps.db, resolved.current);
    const prev = collectAllSpend(this.deps.db, resolved.previous);
    const months = monthsOf(resolved.current);
    const cache = new Map<string, ResolvedCost>();

    const prevByPayee = new Map<string, number>();
    for (const e of prev.events) prevByPayee.set(e.payee_norm, (prevByPayee.get(e.payee_norm) ?? 0) + e.amount);
    const prevByType: Record<CostType, number> = { fixed: 0, variable: 0 };
    for (const e of prev.events) prevByType[this.classify(cache, e).cost_type] += e.amount;

    const rows = new Map<string, CostPayeeRow>();
    for (const e of cur.events) {
      const c = this.classify(cache, e);
      let row = rows.get(e.payee_norm);
      if (!row) {
        row = {
          payee_norm: e.payee_norm, payee_sample: e.payee, cost_type: c.cost_type, utility: c.utility, label: c.label, rule_id: c.rule_id,
          amount: 0, count: 0, business: 0, previous: prevByPayee.get(e.payee_norm) ?? 0,
          monthly: months.map((month) => ({ month, amount: 0 })),
        };
        rows.set(e.payee_norm, row);
      }
      row.amount += e.amount;
      row.count += 1;
      row.business += Math.round(e.amount * this.deps.apportionment.resolve(e.payee).rate);
      const m = row.monthly.find((x) => x.month === e.date.slice(0, 7));
      if (m) m.amount += e.amount;
    }

    const all = [...rows.values()].sort((a, b) => b.amount - a.amount);
    const fixed = all.filter((r) => r.cost_type === "fixed");
    const variable = all.filter((r) => r.cost_type === "variable");
    const spend = all.reduce((t, r) => t + r.amount, 0);
    const totalsOf = (list: CostPayeeRow[], type: CostType): CostTypeTotals => {
      const amount = list.reduce((t, r) => t + r.amount, 0);
      return {
        amount, count: list.reduce((t, r) => t + r.count, 0), business: list.reduce((t, r) => t + r.business, 0),
        previous: prevByType[type], share: spend > 0 ? amount / spend : 0,
      };
    };
    return {
      window: resolved,
      totals: { fixed: totalsOf(fixed, "fixed"), variable: totalsOf(variable, "variable"), spend, previous_spend: prevByType.fixed + prevByType.variable },
      fixed, variable, months, events: cur.events.length, journal_months_used: cur.journalMonths,
    };
  }

  utilities(anchor: string, n = 12): UtilityScan {
    const anchorMonth = anchor.slice(0, 7);
    // 前年同月比のために 12 ヶ月分余計に集める
    const months = monthsEndingAt(anchorMonth, n + 12);
    const range = { from: `${months[0]}-01`, to: `${anchorMonth}-31` };
    return scanUtilities(collectAllSpend(this.deps.db, range).events, this.deps.rules, anchorMonth, n);
  }

  suggestions(anchor: string, n = 6): RecurringCandidate[] {
    const months = monthsEndingAt(anchor.slice(0, 7), n);
    const range = { from: `${months[0]}-01`, to: `${months[months.length - 1]}-31` };
    const { events } = collectAllSpend(this.deps.db, range);
    const cache = new Map<string, ResolvedCost>();
    const spends = new Map<string, MonthlyPayeeSpend>();
    for (const e of events) {
      if (this.classify(cache, e).rule_id !== null) continue; // 既にルールのある店は提案しない
      let s = spends.get(e.payee_norm);
      if (!s) { s = { payee_norm: e.payee_norm, payee_sample: e.payee, months: new Map() }; spends.set(e.payee_norm, s); }
      const month = e.date.slice(0, 7);
      s.months.set(month, (s.months.get(month) ?? 0) + e.amount);
    }
    return detectRecurring([...spends.values()], { windowMonths: months });
  }
}
