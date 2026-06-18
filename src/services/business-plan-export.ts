/**
 * 事業計画を Excel ブックに出力する。 4 シート構成:
 *   概要 / 記述 / 数字 / 検算 (定量メトリクス + findings)。
 *
 * 公式様式 (公庫・補助金) への完全流し込みは別途 (本実装は汎用の構造化出力)。
 */

import ExcelJS from "exceljs";
import type { PlanRow, SectionRow, FigureRow } from "../db/business-plans-repo.js";
import type { PlanTemplate } from "../business-plan/templates.js";
import { runQuant } from "../business-plan/quant.js";
import { toQuantFigures, buildFinancialSummary } from "./business-plan-service.js";

const PURPOSE_LABEL: Record<string, string> = { funding: "融資", subsidy: "補助金", internal: "社内" };
const STATUS_LABEL: Record<string, string> = { draft: "下書き", review: "レビュー中", final: "確定" };
const CATEGORY_LABEL: Record<string, string> = {
  sales: "売上高", cogs: "売上原価", sga: "販管費", fixed_cost: "固定費",
  use_of_funds: "資金使途", funding: "資金調達", repayment: "返済", cashflow: "資金繰り",
  value_added: "付加価値額", labor_cost: "人件費", depreciation: "減価償却費",
};

function periodLabel(p: string): string {
  if (p === "base") return "金額";
  if (p.startsWith("Y")) return `${p.slice(1)}期`;
  if (p.startsWith("M")) return `${p.slice(1)}月`;
  return p;
}
function periodRank(p: string): number {
  if (p === "base") return 0;
  if (p.startsWith("Y")) return 100 + parseInt(p.slice(1), 10);
  if (p.startsWith("M")) return 200 + parseInt(p.slice(1), 10);
  return 999;
}

export async function buildPlanWorkbook(
  plan: PlanRow,
  sections: SectionRow[],
  figures: FigureRow[],
  template: PlanTemplate | undefined,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Quaestor";
  wb.created = new Date();

  // ── 概要シート ──
  const ov = wb.addWorksheet("概要");
  ov.getColumn("A").width = 18;
  ov.getColumn("B").width = 50;
  const meta: [string, string][] = [
    ["計画名", plan.name],
    ["書類テンプレート", template?.name ?? plan.template],
    ["目的", PURPOSE_LABEL[plan.purpose] ?? plan.purpose],
    ["状態", STATUS_LABEL[plan.status] ?? plan.status],
    ["開始年月", plan.fiscal_start ?? "(未設定)"],
    ["計画年数", `${plan.horizon_years}期`],
    ["備考", plan.notes ?? ""],
  ];
  meta.forEach(([k, v], i) => {
    const r = i + 1;
    ov.getCell(`A${r}`).value = k;
    ov.getCell(`A${r}`).font = { bold: true };
    ov.getCell(`B${r}`).value = v;
    ov.getCell(`B${r}`).alignment = { wrapText: true, vertical: "top" };
  });

  // ── 記述シート ──
  const sc = wb.addWorksheet("記述");
  sc.getColumn("A").width = 28;
  sc.getColumn("B").width = 80;
  sc.getCell("A1").value = "項目";
  sc.getCell("B1").value = "内容";
  sc.getRow(1).font = { bold: true };
  let scRow = 2;
  for (const s of sections) {
    const title = template?.sections.find((t) => t.key === s.key)?.title ?? s.key;
    sc.getCell(`A${scRow}`).value = title;
    sc.getCell(`A${scRow}`).font = { bold: true };
    sc.getCell(`A${scRow}`).alignment = { vertical: "top", wrapText: true };
    sc.getCell(`B${scRow}`).value = s.body || "(未記入)";
    sc.getCell(`B${scRow}`).alignment = { wrapText: true, vertical: "top" };
    scRow++;
  }

  // ── 数字シート (category ごとに label × period のマトリクス) ──
  const fg = wb.addWorksheet("数字");
  fg.getColumn("A").width = 28;
  let fgRow = 1;
  const categories = [...new Set(figures.map((f) => f.category))];
  for (const cat of categories) {
    const rows = figures.filter((f) => f.category === cat);
    const periods = [...new Set(rows.map((f) => f.period))].sort((a, b) => periodRank(a) - periodRank(b));
    const labels = [...new Set(rows.map((f) => f.label))];

    fg.getCell(`A${fgRow}`).value = CATEGORY_LABEL[cat] ?? cat;
    fg.getCell(`A${fgRow}`).font = { bold: true, size: 12 };
    fgRow++;
    // ヘッダ行
    periods.forEach((p, i) => {
      const cell = fg.getCell(fgRow, i + 2);
      cell.value = periodLabel(p);
      cell.font = { bold: true };
      cell.alignment = { horizontal: "right" };
      fg.getColumn(i + 2).width = 14;
      fg.getColumn(i + 2).numFmt = "#,##0";
    });
    fgRow++;
    for (const label of labels) {
      fg.getCell(`A${fgRow}`).value = label;
      periods.forEach((p, i) => {
        const f = rows.find((r) => r.label === label && r.period === p);
        if (f && f.amount !== null) fg.getCell(fgRow, i + 2).value = f.amount;
      });
      fgRow++;
    }
    fgRow++; // category 間に空行
  }

  // ── 検算シート (定量メトリクス + findings) ──
  const quant = runQuant(toQuantFigures(figures));
  const qa = wb.addWorksheet("検算");
  qa.getColumn("A").width = 14;
  qa.getColumn("B").width = 70;
  qa.getCell("A1").value = "定量スコア";
  qa.getCell("A1").font = { bold: true };
  qa.getCell("B1").value = `${quant.score} / 100`;
  qa.getCell("A3").value = "数字サマリ";
  qa.getCell("A3").font = { bold: true };
  buildFinancialSummary(quant.metrics).split("\n").forEach((line, i) => {
    qa.getCell(`B${3 + i}`).value = line.replace(/^- /, "");
    qa.getCell(`B${3 + i}`).alignment = { wrapText: true };
  });
  let qaRow = 3 + buildFinancialSummary(quant.metrics).split("\n").length + 1;
  qa.getCell(`A${qaRow}`).value = "指摘";
  qa.getCell(`A${qaRow}`).font = { bold: true };
  qa.getCell(`B${qaRow}`).value = "内容";
  qa.getCell(`B${qaRow}`).font = { bold: true };
  qaRow++;
  if (quant.findings.length === 0) {
    qa.getCell(`B${qaRow}`).value = "指摘なし";
  } else {
    for (const f of quant.findings) {
      qa.getCell(`A${qaRow}`).value = f.severity;
      qa.getCell(`B${qaRow}`).value = f.suggestion ? `${f.message} → ${f.suggestion}` : f.message;
      qa.getCell(`B${qaRow}`).alignment = { wrapText: true };
      qaRow++;
    }
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}
