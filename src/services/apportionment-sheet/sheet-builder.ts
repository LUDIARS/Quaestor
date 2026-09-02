/**
 * 按分シート。 店 (payee_norm) ごとに 1 行:
 *   観測分布 (過去にどの率・科目で何回処理したか) / 現行ルールの解決結果 / 提案 (最多の率・科目) / 状態 / 当年の支出。
 *
 * 状態:
 *   match    — 提案と現行ルールが一致 (何もしなくてよい)
 *   differs  — 現行ルールがあるが提案と違う (人が見る)
 *   proposal — ルール無し、 観測から提案できる (自動生成の対象)
 *   unknown  — ルール無し、 観測も無い (人が決める)
 *
 * @implements SPEC-APPORTIONMENT-SHEET-002 (spec/feature/household-bookkeeping.md)
 */

import type Database from "better-sqlite3";
import type { ApportionmentObservationRow } from "../../db/apportionment-observations-repo.js";
import type { ApportionmentRulesRepo, ResolvedApportionment } from "../../db/apportionment-rules-repo.js";
import { normalizePayee } from "../../shared/text.js";

export type SheetStatus = "match" | "differs" | "proposal" | "unknown";

export interface SheetObservation {
  rate: number;
  code: number;
  occurrences: number;
  total_amount: number;
  sources: string[];
  last_seen: string | null;
}

export interface SheetRow {
  payee_norm: string;
  payee_sample: string;
  observations: SheetObservation[];
  proposed: { rate: number; code: number; occurrences: number } | null;
  current: ResolvedApportionment;
  status: SheetStatus;
  spend_in_year: number;
  tx_count_in_year: number;
}

export interface YearSpend {
  payee_sample: string;
  amount: number;
  count: number;
}

/** 当年の出金取引を店ごとに集める (シートの「影響額」列)。 */
export function collectYearSpend(db: Database.Database, year: number): Map<string, YearSpend> {
  const rows = db
    .prepare(
      `SELECT payee, amount_out FROM transactions
       WHERE is_transfer = 0 AND amount_out IS NOT NULL AND amount_out > 0 AND payee IS NOT NULL
         AND date >= ? AND date <= ?`,
    )
    .all(`${year}-01-01`, `${year}-12-31`) as { payee: string; amount_out: number }[];
  const m = new Map<string, YearSpend>();
  for (const r of rows) {
    const norm = normalizePayee(r.payee);
    if (!norm) continue;
    const cur = m.get(norm) ?? { payee_sample: r.payee.trim(), amount: 0, count: 0 };
    cur.amount += r.amount_out;
    cur.count += 1;
    m.set(norm, cur);
  }
  return m;
}

function groupObservations(rows: ApportionmentObservationRow[]): Map<string, { sample: string; obs: Map<string, SheetObservation> }> {
  const m = new Map<string, { sample: string; obs: Map<string, SheetObservation> }>();
  for (const r of rows) {
    let g = m.get(r.payee_norm);
    if (!g) { g = { sample: r.payee_sample, obs: new Map() }; m.set(r.payee_norm, g); }
    const key = `${r.rate}|${r.code}`;
    const o = g.obs.get(key) ?? { rate: r.rate, code: r.code, occurrences: 0, total_amount: 0, sources: [], last_seen: null };
    o.occurrences += r.occurrences;
    o.total_amount += r.total_amount;
    if (!o.sources.includes(r.source)) o.sources.push(r.source);
    if (r.last_seen && (!o.last_seen || r.last_seen > o.last_seen)) o.last_seen = r.last_seen;
    g.obs.set(key, o);
  }
  return m;
}

export function statusOf(current: ResolvedApportionment, proposed: SheetRow["proposed"]): SheetStatus {
  if (!proposed) return current.rule_id === null ? "unknown" : "match";
  if (current.rule_id === null) return "proposal";
  return current.rate === proposed.rate && current.code === proposed.code ? "match" : "differs";
}

export function buildApportionmentSheet(
  observations: ApportionmentObservationRow[],
  rules: ApportionmentRulesRepo,
  yearSpend: Map<string, YearSpend>,
): SheetRow[] {
  const grouped = groupObservations(observations);
  const payees = new Set<string>([...grouped.keys(), ...yearSpend.keys()]);
  const out: SheetRow[] = [];
  for (const norm of payees) {
    const g = grouped.get(norm);
    const spend = yearSpend.get(norm);
    const sample = spend?.payee_sample ?? g?.sample ?? norm;
    const obs = g ? [...g.obs.values()].sort((a, b) => b.occurrences - a.occurrences || b.total_amount - a.total_amount) : [];
    const top = obs[0];
    const proposed = top ? { rate: top.rate, code: top.code, occurrences: top.occurrences } : null;
    const current = rules.resolve(sample);
    out.push({
      payee_norm: norm,
      payee_sample: sample,
      observations: obs,
      proposed,
      current,
      status: statusOf(current, proposed),
      spend_in_year: spend?.amount ?? 0,
      tx_count_in_year: spend?.count ?? 0,
    });
  }
  const order: Record<SheetStatus, number> = { proposal: 0, differs: 1, unknown: 2, match: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || b.spend_in_year - a.spend_in_year || a.payee_norm.localeCompare(b.payee_norm));
}
