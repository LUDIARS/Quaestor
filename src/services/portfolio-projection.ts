/**
 * 将来価値の投影 (純関数)。
 *
 * 継続積立 × 想定年率で将来の評価額を決定論的に投影する。
 * 月次複利: v_{n+1} = v_n * (1 + r_m) + monthly、 r_m = (1+annual)^(1/12) - 1。
 *
 * 不確実性は「保守 / 中立 / 楽観」の 3 シナリオで表現する (モンテカルロは将来拡張)。
 */

export interface ProjectionPoint {
  month: number;       // 0 = 現在
  contributed: number; // 累計拠出 (元本のみ)
  value: number;       // 評価額 (元本 + 運用益)
}

export interface ProjectionInput {
  currentValue: number;        // 現在評価額 (円)
  monthlyContribution: number; // 毎月の積立額 (円)
  months: number;              // 投影する月数
  annualReturnPct: number;     // 想定年率 (%)
}

/** 1 シナリオの月次投影系列を返す。 month=0 は現在 (拠出前) 。 */
export function projectFuture(input: ProjectionInput): ProjectionPoint[] {
  const rMonthly = Math.pow(1 + input.annualReturnPct / 100, 1 / 12) - 1;
  const points: ProjectionPoint[] = [];
  let value = input.currentValue;
  let contributed = 0; // 現時点以降に追加する元本のみ (現在評価額は別)
  points.push({ month: 0, contributed: 0, value: round0(value) });
  for (let m = 1; m <= input.months; m++) {
    value = value * (1 + rMonthly) + input.monthlyContribution;
    contributed += input.monthlyContribution;
    points.push({ month: m, contributed: round0(contributed), value: round0(value) });
  }
  return points;
}

export interface ScenarioRates {
  conservative: number;
  base: number;
  optimistic: number;
}

/** kind 非依存の既定シナリオ年率 (%)。 必要なら呼び出し側で上書きする。 */
export const DEFAULT_SCENARIO_RATES: ScenarioRates = {
  conservative: 1,
  base: 4,
  optimistic: 7,
};

export interface ScenarioProjection {
  rates: ScenarioRates;
  months: number;
  conservative: ProjectionPoint[];
  base: ProjectionPoint[];
  optimistic: ProjectionPoint[];
  /** 各シナリオの終端評価額 */
  terminal: { conservative: number; base: number; optimistic: number };
  /** 目標額があれば、 base シナリオで到達する月 (未到達なら null) */
  base_months_to_target: number | null;
}

export interface ScenarioInput {
  currentValue: number;
  monthlyContribution: number;
  months: number;
  rates?: ScenarioRates;
  targetAmount?: number | null;
}

export function projectScenarios(input: ScenarioInput): ScenarioProjection {
  const rates = input.rates ?? DEFAULT_SCENARIO_RATES;
  const mk = (annual: number): ProjectionPoint[] =>
    projectFuture({
      currentValue: input.currentValue,
      monthlyContribution: input.monthlyContribution,
      months: input.months,
      annualReturnPct: annual,
    });
  const conservative = mk(rates.conservative);
  const base = mk(rates.base);
  const optimistic = mk(rates.optimistic);
  const terminalOf = (pts: ProjectionPoint[]): number => pts[pts.length - 1]?.value ?? input.currentValue;

  let baseMonthsToTarget: number | null = null;
  if (input.targetAmount != null) {
    const hit = base.find((p) => p.value >= input.targetAmount!);
    baseMonthsToTarget = hit ? hit.month : null;
  }

  return {
    rates,
    months: input.months,
    conservative,
    base,
    optimistic,
    terminal: {
      conservative: terminalOf(conservative),
      base: terminalOf(base),
      optimistic: terminalOf(optimistic),
    },
    base_months_to_target: baseMonthsToTarget,
  };
}

function round0(x: number): number {
  return Math.round(x);
}
