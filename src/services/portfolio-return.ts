/**
 * ポートフォリオの利回り計算 (純関数・テスト容易)。
 *
 * - 取得原価 / 含み損益 / 単純リターン
 * - XIRR (不定期 cashflow の年率内部収益率) — 積立は periodic in/out なので XIRR が妥当
 * - plan-variance (計画拠出 vs 実拠出の乖離)
 *
 * 金額は円 (整数) 前提。 リターンは % で返す。 repo に依存しないプレーンな入力を取る。
 */

export interface CashContribution {
  date: string;   // yyyy-mm-dd
  amount: number; // 投資家視点の拠出 (入金=正)。 取崩しは負
  kind: "planned" | "actual";
}

export interface CashDividend {
  pay_date: string;
  amount: number;     // 受取額 (円)
  reinvested: boolean; // true は評価額に内包済 (cashflow に数えない)
}

export interface ReturnInput {
  contributions: CashContribution[];
  dividends: CashDividend[];
  /** 直近評価 (無ければ含み損益・XIRR は null になる) */
  marketValue: number | null;
  valuationAsOf: string | null;
  /** plan-variance の基準日 (yyyy-mm-dd)。 通常は当日 */
  asOf: string;
  /** 計画積立額 (円/月)。 planned 行が無いときの計画到達額の合成に使う */
  monthlyContribution?: number | null;
  /** 積立開始日 (monthlyContribution からの合成に使う) */
  startedAt?: string | null;
}

export interface ReturnResult {
  invested: number;             // 実拠出の純額 (actual の合計)
  market_value: number | null;
  dividends_received: number;   // reinvested=false の合計
  unrealized_pl: number | null; // market_value - invested
  total_return: number | null;  // unrealized_pl + dividends_received
  simple_return_pct: number | null;
  annualized_xirr_pct: number | null;
  // plan-variance
  planned_to_date: number | null;
  actual_to_date: number;
  variance: number | null;      // actual_to_date - planned_to_date
  variance_pct: number | null;
}

export function computeHoldingReturn(input: ReturnInput): ReturnResult {
  const actuals = input.contributions.filter((c) => c.kind === "actual");
  const invested = sum(actuals.map((c) => c.amount));
  const dividendsReceived = sum(input.dividends.filter((d) => !d.reinvested).map((d) => d.amount));
  const mv = input.marketValue;

  // 取得原価が未入力 (invested<=0) の銘柄は「評価額=全額が利益」と誤計上しないよう
  // 含み損益を算出しない (null)。 取得原価を入れると損益が出る。
  const unrealized = mv != null && invested > 0 ? mv - invested : null;
  const totalReturn = unrealized != null ? unrealized + dividendsReceived : null;
  const simpleReturnPct =
    totalReturn != null && invested > 0 ? round2((totalReturn / invested) * 100) : null;

  // XIRR: 実拠出 (負: 投資へ出ていく) + 非再投資配当 (正) + 終端評価額 (正)
  let xirrPct: number | null = null;
  if (mv != null && input.valuationAsOf && invested > 0) {
    const flows: XirrFlow[] = [];
    for (const c of actuals) flows.push({ date: c.date, amount: -c.amount });
    for (const d of input.dividends) if (!d.reinvested) flows.push({ date: d.pay_date, amount: d.amount });
    flows.push({ date: input.valuationAsOf, amount: mv });
    const r = xirr(flows);
    if (r != null && Number.isFinite(r)) xirrPct = round2(r * 100);
  }

  // plan-variance
  const plannedRows = input.contributions.filter((c) => c.kind === "planned");
  let plannedToDate: number | null = null;
  if (plannedRows.length > 0) {
    plannedToDate = sum(plannedRows.filter((c) => c.date <= input.asOf).map((c) => c.amount));
  } else if (input.monthlyContribution && input.startedAt) {
    // 起算日に第1回を拠出する月次積立として数える。 開始月を含むため経過月数 + 1。
    // 例: 2025-12-01 開始を 2026-06-18 時点で見ると 12/1〜6/1 の 7 回 = monthsBetween(=6) + 1。
    const elapsed = monthsBetween(input.startedAt, input.asOf);
    plannedToDate = elapsed >= 0 ? input.monthlyContribution * (elapsed + 1) : 0;
  }
  const actualToDate = sum(actuals.filter((c) => c.date <= input.asOf).map((c) => c.amount));
  const variance = plannedToDate != null ? actualToDate - plannedToDate : null;
  const variancePct =
    variance != null && plannedToDate && plannedToDate !== 0
      ? round2((variance / plannedToDate) * 100)
      : null;

  return {
    invested,
    market_value: mv,
    dividends_received: dividendsReceived,
    unrealized_pl: unrealized,
    total_return: totalReturn,
    simple_return_pct: simpleReturnPct,
    annualized_xirr_pct: xirrPct,
    planned_to_date: plannedToDate,
    actual_to_date: actualToDate,
    variance,
    variance_pct: variancePct,
  };
}

// ── XIRR ──────────────────────────────────────────────────────────────────

export interface XirrFlow {
  date: string; // yyyy-mm-dd
  amount: number;
}

/**
 * XIRR: sum( cf_i / (1+r)^(days_i/365) ) = 0 を満たす年率 r を解く。
 * Newton 法 → 収束しなければ二分法でフォールバック。 解が無ければ null。
 */
export function xirr(flows: XirrFlow[]): number | null {
  const cfs = flows.filter((f) => Number.isFinite(f.amount));
  if (cfs.length < 2) return null;
  const hasPos = cfs.some((f) => f.amount > 0);
  const hasNeg = cfs.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) return null; // 符号が片方だけだと解なし

  const t0 = new Date(`${cfs[0]!.date}T00:00:00Z`).getTime();
  const years = cfs.map((f) => (new Date(`${f.date}T00:00:00Z`).getTime() - t0) / (365 * 86400_000));

  const npv = (r: number): number =>
    cfs.reduce((acc, f, i) => acc + f.amount / Math.pow(1 + r, years[i]!), 0);
  const dnpv = (r: number): number =>
    cfs.reduce((acc, f, i) => acc - (years[i]! * f.amount) / Math.pow(1 + r, years[i]! + 1), 0);

  // Newton 法 (初期値 10%)
  let r = 0.1;
  for (let iter = 0; iter < 100; iter++) {
    const f = npv(r);
    const d = dnpv(r);
    if (Math.abs(f) < 1e-7) return r;
    if (d === 0 || !Number.isFinite(d)) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }

  // 二分法フォールバック (-99% 〜 +1000%)
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  let fhi = npv(hi);
  if (flo * fhi > 0) return null; // 区間に符号変化なし
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid);
    if (Math.abs(fmid) < 1e-7) return mid;
    if (flo * fmid < 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

// ── helpers ────────────────────────────────────────────────────────────────

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 2 つの yyyy-mm-dd の経過月数 (整数, from < to で正)。 端数月は切り捨て。 */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1; // 日割りで 1 ヶ月未満は数えない
  return months;
}
