/**
 * 固定費候補の自動判定 (純関数)。
 * 直近 N ヶ月のうち minMonths 以上に出現し、 月合計の変動係数 (σ/μ) が maxCv 以下の店を候補にする。
 * @implements SPEC-COST-STRUCTURE-003 (spec/feature/cost-structure.md)
 */

export interface MonthlyPayeeSpend {
  payee_norm: string;
  payee_sample: string;
  /** YYYY-MM → 合計 */
  months: Map<string, number>;
}

export interface RecurringCandidate {
  payee_norm: string;
  payee_sample: string;
  months_present: number;
  months_window: number;
  average: number;
  cv: number;
  monthly: { month: string; amount: number }[];
}

export interface DetectOptions {
  windowMonths: string[];   // 対象の YYYY-MM (昇順)
  minMonths?: number;       // 既定 3
  maxCv?: number;           // 既定 0.25
}

export function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return Infinity;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean <= 0) return Infinity;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export function detectRecurring(spends: MonthlyPayeeSpend[], opts: DetectOptions): RecurringCandidate[] {
  const minMonths = opts.minMonths ?? 3;
  const maxCv = opts.maxCv ?? 0.25;
  const out: RecurringCandidate[] = [];
  for (const s of spends) {
    const monthly = opts.windowMonths.map((m) => ({ month: m, amount: s.months.get(m) ?? 0 }));
    const present = monthly.filter((x) => x.amount > 0);
    if (present.length < minMonths) continue;
    const cv = coefficientOfVariation(present.map((x) => x.amount));
    if (cv > maxCv) continue;
    const average = Math.round(present.reduce((t, x) => t + x.amount, 0) / present.length);
    out.push({ payee_norm: s.payee_norm, payee_sample: s.payee_sample, months_present: present.length, months_window: opts.windowMonths.length, average, cv: Math.round(cv * 1000) / 1000, monthly });
  }
  return out.sort((a, b) => b.average * b.months_present - a.average * a.months_present);
}
