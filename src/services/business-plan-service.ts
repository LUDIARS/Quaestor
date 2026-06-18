/**
 * 事業計画レビューのオーケストレーション。
 * figure 行 → quant 入力変換、 数字サマリ生成、 レビュー実行 (定量/定性/結合)、 実績取り込み。
 */

import type Database from "better-sqlite3";
import type { BusinessPlansRepo, FigureRow, ReviewKind } from "../db/business-plans-repo.js";
import type { FinancialStatementsRepo } from "../db/financial-statements-repo.js";
import { runQuant, type QuantFigure, type QuantMetrics, type Finding } from "../business-plan/quant.js";
import { getTemplate } from "../business-plan/templates.js";
import { planWindows, buildVariance, type VarianceResult, type PeriodActuals } from "../business-plan/variance.js";
import type { PlanReviewer } from "./plan-reviewer.js";

/** DB figure 行を quant 入力に射影 (metadata.tag を展開) */
export function toQuantFigures(rows: FigureRow[]): QuantFigure[] {
  return rows.map((r) => {
    let tag: string | null = null;
    if (r.metadata) {
      try { tag = (JSON.parse(r.metadata) as { tag?: string }).tag ?? null; } catch { tag = null; }
    }
    return { category: r.category, label: r.label, period: r.period, amount: r.amount, tag };
  });
}

const yen = (n: number): string => `${n.toLocaleString("ja-JP")}円`;

/** quant metrics を Claude へ渡す人間可読サマリに変換 */
export function buildFinancialSummary(m: QuantMetrics): string {
  const lines: string[] = [];
  for (const p of m.pnl) {
    const margin = p.operatingMargin !== null ? ` 営業利益率${(p.operatingMargin * 100).toFixed(1)}%` : "";
    lines.push(`- ${p.period}: 売上${yen(p.sales)} 原価${yen(p.cogs)} 販管費${yen(p.sga)} 営業利益${yen(p.operatingProfit)}${margin}`);
  }
  if (m.breakEven?.breakEvenSales != null) {
    lines.push(`- 損益分岐点売上高(${m.breakEven.period}): ${yen(m.breakEven.breakEvenSales)}`);
  }
  if (m.funding) {
    const ratio = m.funding.ownFundsRatio !== null ? `${(m.funding.ownFundsRatio * 100).toFixed(1)}%` : "—";
    lines.push(`- 資金調達: 調達計${yen(m.funding.totalFunding)} / 使途計${yen(m.funding.totalUseOfFunds)} / 自己資金比率${ratio}${m.funding.balanced ? "" : " (調達と使途が不一致)"}`);
  }
  if (m.repayment?.coverage != null) {
    lines.push(`- 返済余力(${m.repayment.period}): 営業利益${yen(m.repayment.operatingProfit)} / 年間返済${yen(m.repayment.annualRepayment)} (倍率${m.repayment.coverage.toFixed(2)})`);
  }
  if (m.cashflow) {
    const short = m.cashflow.shortageMonth !== null ? ` ${m.cashflow.shortageMonth}月目に資金ショート` : " ショートなし";
    lines.push(`- 資金繰り: 最小月末残高${yen(m.cashflow.minBalance)}${short}`);
  }
  if (m.valueAdded?.meetsThreeP != null) {
    lines.push(`- 付加価値額年率+3%: ${m.valueAdded.meetsThreeP ? "達成" : "未達"}`);
  }
  return lines.length ? lines.join("\n") : "(数字が未入力です)";
}

/** 計画の記述 + 数字サマリを 1 つのテキストにまとめる (補助金マッチング等の入力用) */
export function buildPlanSummaryText(repo: BusinessPlansRepo, planId: string): string {
  const plan = repo.find(planId);
  if (!plan) throw new Error("plan not found");
  const tpl = getTemplate(plan.template);
  const sections = repo.sections(planId)
    .map((s) => {
      const title = tpl?.sections.find((t) => t.key === s.key)?.title ?? s.key;
      return `## ${title}\n${s.body.trim() || "(未記入)"}`;
    })
    .join("\n");
  const quant = runQuant(toQuantFigures(repo.figures(planId)));
  return `テンプレート: ${tpl?.name ?? plan.template} / 目的: ${plan.purpose}\n\n# 記述\n${sections}\n\n# 数字\n${buildFinancialSummary(quant.metrics)}`;
}

export type RunReviewKind = ReviewKind;

export interface RunReviewResult {
  kind: ReviewKind;
  score: number;
  summary: string;
  findings: Finding[];
  metrics: QuantMetrics;
  model: string | null;
}

/**
 * レビューを実行し business_plan_reviews に保存する。
 * kind=quantitative は純関数のみ。 qualitative/combined は reviewer 必須 (無ければ quant に縮退)。
 */
export async function runReview(
  repo: BusinessPlansRepo,
  planId: string,
  kind: ReviewKind,
  reviewer: PlanReviewer | undefined,
): Promise<RunReviewResult> {
  const plan = repo.find(planId);
  if (!plan) throw new Error("plan not found");

  const figures = toQuantFigures(repo.figures(planId));
  const quant = runQuant(figures);

  let findings: Finding[] = [...quant.findings];
  let summary = "";
  let score = quant.score;
  let model: string | null = null;
  let effectiveKind: ReviewKind = "quantitative";

  const wantQualitative = kind === "qualitative" || kind === "combined";
  if (wantQualitative && reviewer) {
    const tpl = getTemplate(plan.template);
    const sectionRows = repo.sections(planId);
    const sections = sectionRows.map((s) => ({
      title: tpl?.sections.find((t) => t.key === s.key)?.title ?? s.key,
      body: s.body,
    }));
    const qual = await reviewer.review({
      templateName: tpl?.name ?? plan.template,
      purpose: plan.purpose,
      sections,
      financialSummary: buildFinancialSummary(quant.metrics),
    });
    summary = qual.summary;
    if (kind === "qualitative") {
      findings = qual.findings;
      score = qual.score;
      effectiveKind = "qualitative";
    } else {
      // combined: 定量 findings + 定性 findings、 スコアは両者の平均
      findings = [...quant.findings, ...qual.findings];
      score = Math.round((quant.score + qual.score) / 2);
      effectiveKind = "combined";
    }
    model = (reviewer as { modelName?: string }).modelName ?? "claude";
  }

  repo.insertReview({
    plan_id: planId,
    kind: effectiveKind,
    score,
    summary,
    findings,
    metrics: quant.metrics,
    model,
  });

  return { kind: effectiveKind, score, summary, findings, metrics: quant.metrics, model };
}

export interface SeedFromActualsResult {
  year: number | null;
  applied: { category: string; period: string; amount: number }[];
}

/**
 * 直近の financial_statements (P&L) を計画の Y1 baseline に取り込む。
 * 既存 figure 行 (category sales/cogs/sga × Y1) の amount を実績で上書きし source='from_actuals'。
 */
export function seedFromActuals(
  repo: BusinessPlansRepo,
  fs: FinancialStatementsRepo,
  planId: string,
): SeedFromActualsResult {
  const plan = repo.find(planId);
  if (!plan) throw new Error("plan not found");

  const years = fs.years();
  const year = years[0] ?? null;
  if (year === null) return { year: null, applied: [] };

  const plRows = fs.findYear(year).filter((r) => r.section === "pl");
  const pick = (kw: string): number | null => {
    const row = plRows.find((r) => r.label.includes(kw));
    return row?.amount ?? null;
  };
  const sales = pick("売上");
  const expenses = pick("経費");

  const figures = repo.figures(planId);
  const applied: { category: string; period: string; amount: number }[] = [];
  const updates: { category: string; label: string; period: string; amount: number; display_order: number }[] = [];

  const firstOf = (category: string): FigureRow | undefined =>
    figures.find((f) => f.category === category && f.period === "Y1");

  if (sales !== null) {
    const row = firstOf("sales");
    if (row) {
      updates.push({ category: row.category, label: row.label, period: "Y1", amount: sales, display_order: row.display_order });
      applied.push({ category: "sales", period: "Y1", amount: sales });
    }
  }
  if (expenses !== null) {
    // sga 行があれば sga へ、 無ければ cogs へ寄せる (テンプレに sga が無い場合の保険)
    const row = firstOf("sga") ?? firstOf("cogs");
    if (row) {
      updates.push({ category: row.category, label: row.label, period: "Y1", amount: expenses, display_order: row.display_order });
      applied.push({ category: row.category, period: "Y1", amount: expenses });
    }
  }

  if (updates.length > 0) {
    repo.upsertFigures(planId, updates.map((u) => ({ ...u, source: "from_actuals" as const })));
  }
  return { year, applied };
}

/**
 * 計画 vs 実績の差異分析。 fiscal_start 起点で各年度の窓を作り、 実績
 * (売上=invoices, 経費=transactions出金) を集計して計画と突合する。
 */
export function computePlanVariance(
  repo: BusinessPlansRepo,
  db: Database.Database,
  planId: string,
  today: string,
): VarianceResult {
  const plan = repo.find(planId);
  if (!plan) throw new Error("plan not found");
  if (!plan.fiscal_start) {
    return { available: false, rows: [], reason: "開始年月 (fiscal_start) が未設定です。計画のメタ情報で設定してください。" };
  }

  const windows = planWindows(plan.fiscal_start, plan.horizon_years);
  if (windows.length === 0) {
    return { available: false, rows: [], reason: "fiscal_start の形式が不正です (yyyy-mm)。" };
  }

  const pnl = runQuant(toQuantFigures(repo.figures(planId))).metrics.pnl;

  const salesStmt = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM invoices
     WHERE issued_at >= ? AND issued_at <= ? AND status != 'cancelled'`,
  );
  const expenseStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_out), 0) AS s FROM transactions
     WHERE date >= ? AND date <= ? AND is_transfer = 0`,
  );

  const actualsByPeriod: Record<string, PeriodActuals> = {};
  for (const w of windows) {
    if (w.from > today) continue; // 未到来の窓は実績ゼロのまま (elapsed=false で表示側が判別)
    const sales = (salesStmt.get(w.from, w.to) as { s: number }).s;
    const expenses = (expenseStmt.get(w.from, w.to) as { s: number }).s;
    actualsByPeriod[w.period] = { sales, expenses };
  }

  return { available: true, rows: buildVariance(pnl, windows, actualsByPeriod, today) };
}
