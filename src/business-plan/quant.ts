/**
 * 事業計画の定量検算 (純関数・LLM 不要)。
 *
 * figure 行配列を受けて、 年次 P&L / 損益分岐 / 資金調達バランス / 返済余力 / 資金繰り /
 * 付加価値額成長 を計算し、 ルールベースの findings とスコアを返す。
 *
 * 金額は整数 (円)。 amount=null は 0 として扱わず「未入力」として扱う箇所がある。
 */

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  area: string;      // "quant" / section key 等
  code: string;      // 機械可読コード
  message: string;
  suggestion?: string;
}

/** quant が受け取る最小の figure 表現 (DB 行から射影) */
export interface QuantFigure {
  category: string;
  label: string;
  period: string;    // "base" | "Y1".. | "M1"..
  amount: number | null;
  tag?: string | null;     // "own_funds" | "subsidy_grant"
}

export interface YearPnl {
  period: string;          // "Y1"..
  sales: number;
  cogs: number;
  grossProfit: number;
  sga: number;
  operatingProfit: number;
  operatingMargin: number | null; // 営業利益率 (sales=0 なら null)
}

export interface QuantMetrics {
  pnl: YearPnl[];
  breakEven: {
    period: string;
    fixedCost: number;
    variableRatio: number | null;
    breakEvenSales: number | null;   // 損益分岐点売上高
    marginOfSafety: number | null;   // 安全余裕率 = (売上 - 分岐点)/売上
  } | null;
  funding: {
    totalFunding: number;
    totalUseOfFunds: number;
    ownFunds: number;
    ownFundsRatio: number | null;    // 自己資金 / Σ調達
    balanced: boolean;               // Σ調達 == Σ使途
    gap: number;                     // Σ調達 - Σ使途
  } | null;
  repayment: {
    period: string;
    annualRepayment: number;
    operatingProfit: number;
    coverage: number | null;         // 営業利益 / 年間返済額
  } | null;
  cashflow: {
    openingBalance: number;
    monthEnd: number[];              // M1..M12 月末残高
    minBalance: number;
    shortageMonth: number | null;    // 1-based、 マイナスに落ちた最初の月。 無ければ null
  } | null;
  valueAdded: {
    series: { period: string; amount: number }[];
    yoyGrowth: (number | null)[];    // 前年比 (%) 0 番目は null
    meetsThreeP: boolean | null;     // 全期 +3% 以上か
  } | null;
}

export interface QuantResult {
  metrics: QuantMetrics;
  findings: Finding[];
  score: number;     // 0..100
}

const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 指定 category / period の amount 合計 (null は 0 扱い) */
function sumOf(figs: QuantFigure[], category: string, period?: string): number {
  return figs
    .filter((f) => f.category === category && (period === undefined || f.period === period))
    .reduce((s, f) => s + num(f.amount), 0);
}

/** category に存在する year period (Y1..) を昇順で集める */
function yearPeriods(figs: QuantFigure[]): string[] {
  const set = new Set<string>();
  for (const f of figs) if (/^Y\d+$/.test(f.period)) set.add(f.period);
  return [...set].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
}

function computePnl(figs: QuantFigure[]): YearPnl[] {
  return yearPeriods(figs).map((period) => {
    const sales = sumOf(figs, "sales", period);
    const cogs = sumOf(figs, "cogs", period);
    const sga = sumOf(figs, "sga", period);
    const grossProfit = sales - cogs;
    const operatingProfit = grossProfit - sga;
    return {
      period,
      sales,
      cogs,
      grossProfit,
      sga,
      operatingProfit,
      operatingMargin: sales > 0 ? operatingProfit / sales : null,
    };
  });
}

function computeBreakEven(figs: QuantFigure[], firstYear: string | undefined): QuantMetrics["breakEven"] {
  if (!firstYear) return null;
  const sales = sumOf(figs, "sales", firstYear);
  const cogs = sumOf(figs, "cogs", firstYear);
  // 固定費: fixed_cost があれば優先、 無ければ販管費を固定費とみなす
  const explicitFixed = sumOf(figs, "fixed_cost", firstYear);
  const fixedCost = explicitFixed > 0 ? explicitFixed : sumOf(figs, "sga", firstYear);
  const variableRatio = sales > 0 ? cogs / sales : null;
  let breakEvenSales: number | null = null;
  if (variableRatio !== null && variableRatio < 1) {
    breakEvenSales = Math.round(fixedCost / (1 - variableRatio));
  }
  const marginOfSafety = breakEvenSales !== null && sales > 0 ? (sales - breakEvenSales) / sales : null;
  return { period: firstYear, fixedCost, variableRatio, breakEvenSales, marginOfSafety };
}

function computeFunding(figs: QuantFigure[]): QuantMetrics["funding"] {
  const hasFunding = figs.some((f) => f.category === "funding" || f.category === "use_of_funds");
  if (!hasFunding) return null;
  const totalFunding = sumOf(figs, "funding");
  const totalUseOfFunds = sumOf(figs, "use_of_funds");
  const ownFunds = figs
    .filter((f) => f.category === "funding" && f.tag === "own_funds")
    .reduce((s, f) => s + num(f.amount), 0);
  return {
    totalFunding,
    totalUseOfFunds,
    ownFunds,
    ownFundsRatio: totalFunding > 0 ? ownFunds / totalFunding : null,
    balanced: totalFunding === totalUseOfFunds,
    gap: totalFunding - totalUseOfFunds,
  };
}

function computeRepayment(figs: QuantFigure[], pnl: YearPnl[], firstYear: string | undefined): QuantMetrics["repayment"] {
  if (!firstYear) return null;
  const annualRepayment = sumOf(figs, "repayment", firstYear);
  if (annualRepayment === 0 && !figs.some((f) => f.category === "repayment")) return null;
  const operatingProfit = pnl.find((p) => p.period === firstYear)?.operatingProfit ?? 0;
  return {
    period: firstYear,
    annualRepayment,
    operatingProfit,
    coverage: annualRepayment > 0 ? operatingProfit / annualRepayment : null,
  };
}

function computeCashflow(figs: QuantFigure[]): QuantMetrics["cashflow"] {
  const monthly = figs.filter((f) => f.category === "cashflow" && /^M\d+$/.test(f.period));
  if (monthly.length === 0) return null;
  // 期首残高: cashflow/base (label 期首残高) があれば採用
  const openingBalance = sumOf(figs, "cashflow", "base");
  const monthEnd: number[] = [];
  let running = openingBalance;
  let shortageMonth: number | null = null;
  for (let m = 1; m <= 12; m++) {
    running += sumOf(figs, "cashflow", `M${m}`);
    monthEnd.push(running);
    if (running < 0 && shortageMonth === null) shortageMonth = m;
  }
  return {
    openingBalance,
    monthEnd,
    minBalance: Math.min(...monthEnd),
    shortageMonth,
  };
}

function computeValueAdded(figs: QuantFigure[]): QuantMetrics["valueAdded"] {
  const periods = yearPeriods(figs.filter((f) => f.category === "value_added"));
  if (periods.length === 0) return null;
  const series = periods.map((period) => ({ period, amount: sumOf(figs, "value_added", period) }));
  const yoyGrowth: (number | null)[] = series.map((s, i) => {
    if (i === 0) return null;
    const prev = series[i - 1]!.amount;
    return prev > 0 ? ((s.amount - prev) / prev) * 100 : null;
  });
  const growths = yoyGrowth.filter((g): g is number => g !== null);
  const meetsThreeP = growths.length > 0 ? growths.every((g) => g >= 3 - 1e-9) : null;
  return { series, yoyGrowth, meetsThreeP };
}

/** ルールベースで findings を導出 */
function deriveFindings(m: QuantMetrics): Finding[] {
  const out: Finding[] = [];
  const y1 = m.pnl[0];

  if (y1 && y1.sales === 0) {
    out.push({ severity: "warning", area: "quant", code: "no_sales", message: "初年度の売上高が未入力 (0) です。", suggestion: "客数×単価 等の根拠から売上計画を入力してください。" });
  }
  if (y1 && y1.sales > 0 && y1.operatingProfit < 0) {
    out.push({ severity: "warning", area: "quant", code: "y1_operating_loss", message: `初年度が営業赤字 (営業利益 ${fmt(y1.operatingProfit)} 円) です。`, suggestion: "原価率・固定費の見直し、 または黒字化の時期を記述で説明してください。" });
  }

  if (m.breakEven && m.breakEven.breakEvenSales !== null && y1) {
    if (m.breakEven.breakEvenSales > y1.sales) {
      out.push({ severity: "warning", area: "quant", code: "below_break_even", message: `損益分岐点売上高 ${fmt(m.breakEven.breakEvenSales)} 円が計画売上 ${fmt(y1.sales)} 円を上回ります。`, suggestion: "売上を上げるか固定費を下げないと初年度から赤字です。" });
    }
  }
  if (m.breakEven && m.breakEven.variableRatio !== null && m.breakEven.variableRatio >= 1) {
    out.push({ severity: "error", area: "quant", code: "negative_margin", message: "売上原価が売上を上回っており限界利益がマイナスです。", suggestion: "売価・原価の前提を見直してください。" });
  }

  if (m.funding) {
    if (!m.funding.balanced) {
      out.push({ severity: "error", area: "quant", code: "funding_unbalanced", message: `資金調達 ${fmt(m.funding.totalFunding)} 円と資金使途 ${fmt(m.funding.totalUseOfFunds)} 円が一致しません (差 ${fmt(m.funding.gap)} 円)。`, suggestion: "「必要な資金」と「調達方法」の合計を揃えてください。" });
    }
    if (m.funding.ownFundsRatio !== null && m.funding.ownFundsRatio < 0.1) {
      out.push({ severity: "warning", area: "quant", code: "low_own_funds", message: `自己資金比率が ${(m.funding.ownFundsRatio * 100).toFixed(1)}% で、 公庫の目安 (1/10 以上) を下回ります。`, suggestion: "自己資金を増やすか、 比率が低い理由を説明できるようにしてください。" });
    }
  }

  if (m.repayment && m.repayment.coverage !== null) {
    if (m.repayment.coverage < 1) {
      out.push({ severity: "warning", area: "quant", code: "weak_repayment", message: `初年度の返済余力が不足 (営業利益 ${fmt(m.repayment.operatingProfit)} 円 < 年間返済額 ${fmt(m.repayment.annualRepayment)} 円)。`, suggestion: "返済財源 (利益+減価償却) が年間返済額を上回る計画にしてください。" });
    }
  }

  if (m.cashflow && m.cashflow.shortageMonth !== null) {
    out.push({ severity: "error", area: "quant", code: "cash_shortage", message: `初年度 ${m.cashflow.shortageMonth} 月目に資金ショート (月末残高 ${fmt(m.cashflow.monthEnd[m.cashflow.shortageMonth - 1] ?? 0)} 円)。`, suggestion: "運転資金の上積み、 または入出金タイミングの見直しが必要です。" });
  }

  if (m.valueAdded && m.valueAdded.meetsThreeP === false) {
    out.push({ severity: "warning", area: "quant", code: "value_added_below_3p", message: "付加価値額の年率成長が +3% を下回る期があります (ものづくり補助金の要件)。", suggestion: "売上増・効率化で付加価値額を年3%以上伸ばす計画にしてください。" });
  }

  return out;
}

function scoreFrom(findings: Finding[]): number {
  let score = 100;
  for (const f of findings) {
    score -= f.severity === "error" ? 25 : f.severity === "warning" ? 10 : 3;
  }
  return Math.max(0, Math.min(100, score));
}

/** 事業計画の定量検算を実行する */
export function runQuant(figures: QuantFigure[]): QuantResult {
  const pnl = computePnl(figures);
  const firstYear = pnl[0]?.period;
  const metrics: QuantMetrics = {
    pnl,
    breakEven: computeBreakEven(figures, firstYear),
    funding: computeFunding(figures),
    repayment: computeRepayment(figures, pnl, firstYear),
    cashflow: computeCashflow(figures),
    valueAdded: computeValueAdded(figures),
  };
  const findings = deriveFindings(metrics);
  return { metrics, findings, score: scoreFrom(findings) };
}

function fmt(n: number): string {
  return n.toLocaleString("ja-JP");
}
