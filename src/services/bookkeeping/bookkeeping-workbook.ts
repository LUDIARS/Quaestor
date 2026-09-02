/**
 * エクセル簿記互換ブックの書き出し。 5 つの帳簿シートと、入力がある場合は減価償却シートを作る。
 * 数式は書かず値のみ (集計は Quaestor 側で確定済み)。 仕訳帳はエクセル簿記と同じ 7 行目見出し・8 行目データ。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-004 (spec/feature/household-bookkeeping.md)
 * @implements SPEC-DEPRECIATION-002 (spec/feature/depreciation.md)
 */

import ExcelJS from "exceljs";
import { writeJournalSheet, type JournalSheetRow } from "../excel-export.js";
import type { TrialBalance } from "./trial-balance.js";
import type { GeneralLedger } from "./general-ledger.js";
import type { MonthlySummary } from "./monthly-summary.js";
import type { FinancialReport } from "./financial-report.js";
import type { YearSchedule } from "../depreciation/depreciation-schedule.js";

export interface BookkeepingWorkbookInput {
  fiscal_year: number;
  journal: JournalSheetRow[];
  trial_balance: TrialBalance;
  ledgers: GeneralLedger[];
  monthly: MonthlySummary;
  report: FinancialReport;
  /** 減価償却表 (③)。 省略時はシートを作らない */
  depreciation?: YearSchedule;
}

const MONEY = "#,##0";
const EXCEL_B_JOURNAL_HEADER_ROW = 7;

export async function buildBookkeepingWorkbook(input: BookkeepingWorkbookInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Quaestor";
  wb.created = new Date();

  writeJournal(wb.addWorksheet("仕訳帳", { properties: { defaultColWidth: 14 } }), input);
  writeTrialBalance(wb.addWorksheet("精算表"), input.trial_balance, input.fiscal_year);
  writeLedgers(wb.addWorksheet("元帳"), input.ledgers);
  writeMonthly(wb.addWorksheet("月別集計"), input.monthly);
  writeReport(wb.addWorksheet("決算書"), input.report, input.fiscal_year);
  if (input.depreciation) writeDepreciation(wb.addWorksheet("減価償却"), input.depreciation);

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

function writeJournal(ws: ExcelJS.Worksheet, input: BookkeepingWorkbookInput): void {
  ws.getCell("F2").value = "【仕訳帳】";
  ws.getCell("B5").value = "日付";
  ws.getCell("C5").value = "№";
  ws.getCell("D5").value = "借　　　　方";
  ws.getCell("G5").value = "貸　　　　方";
  ws.getCell("J5").value = "摘　　要";
  ws.getCell("K5").value = "計算用";
  writeJournalSheet(ws, input.journal, { headerRow: EXCEL_B_JOURNAL_HEADER_ROW });
}

function writeTrialBalance(ws: ExcelJS.Worksheet, tb: TrialBalance, year: number): void {
  ws.getCell("G2").value = `【精算表】 ${year} 年`;
  const headers = ["科目コード", "勘定科目", "期首 借方", "期首 貸方", "残高試算表 借方", "残高試算表 貸方",
    "損益計算書 借方", "損益計算書 貸方", "貸借対照表 借方", "貸借対照表 貸方"];
  headers.forEach((h, i) => { ws.getCell(5, 2 + i).value = h; });
  ws.getRow(5).font = { bold: true };
  let r = 6;
  for (const row of tb.rows) {
    const vals = [row.code, row.name, row.opening_debit, row.opening_credit, row.debit_total, row.credit_total,
      row.pl_debit, row.pl_credit, row.bs_debit, row.bs_credit];
    vals.forEach((v, i) => { ws.getCell(r, 2 + i).value = v; });
    r++;
  }
  r++;
  ws.getCell(r, 3).value = "準計";
  putTotals(ws, r, tb.subtotal);
  if (tb.opening_equity) {
    r++;
    ws.getCell(r, 3).value = "元入金（期首差額）";
    ws.getCell(r, tb.opening_equity > 0 ? 11 : 10).value = Math.abs(tb.opening_equity);
  }
  r++;
  ws.getCell(r, 3).value = "青色申告特別控除前の所得金額";
  ws.getCell(r, 8).value = Math.max(tb.income, 0);
  ws.getCell(r, 9).value = Math.max(-tb.income, 0);
  ws.getCell(r, 10).value = Math.max(-tb.income, 0);
  ws.getCell(r, 11).value = Math.max(tb.income, 0);
  r++;
  ws.getCell(r, 3).value = "合　　　計";
  putTotals(ws, r, tb.total);
  for (let c = 4; c <= 11; c++) ws.getColumn(c).numFmt = MONEY;
  ws.getColumn(3).width = 22;
  ws.views = [{ state: "frozen", ySplit: 5 }];
}

function putTotals(ws: ExcelJS.Worksheet, r: number, t: TrialBalance["subtotal"]): void {
  const vals = [t.opening_debit, t.opening_credit, t.debit_total, t.credit_total, t.pl_debit, t.pl_credit, t.bs_debit, t.bs_credit];
  vals.forEach((v, i) => { ws.getCell(r, 4 + i).value = v; });
  ws.getRow(r).font = { bold: true };
}

function writeLedgers(ws: ExcelJS.Worksheet, ledgers: GeneralLedger[]): void {
  ws.getCell("B2").value = "【総勘定元帳】";
  let r = 4;
  for (const l of ledgers) {
    if (l.lines.length === 0 && l.opening === 0) continue;
    ws.getCell(r, 2).value = `${l.code} ${l.name}`;
    ws.getRow(r).font = { bold: true };
    r++;
    ["日付", "№", "相手科目", "摘要", "借方金額", "貸方金額", "残高"].forEach((h, i) => { ws.getCell(r, 2 + i).value = h; });
    r++;
    if (l.opening) {
      ws.getCell(r, 5).value = "期首残高";
      ws.getCell(r, 8).value = l.opening;
      r++;
    }
    for (const line of l.lines) {
      const vals = [line.entry_date, line.no, `${line.counter_code} ${line.counter_name}`, line.description,
        line.debit || null, line.credit || null, line.balance];
      vals.forEach((v, i) => { ws.getCell(r, 2 + i).value = v; });
      r++;
    }
    ws.getCell(r, 5).value = "合計 / 期末残高";
    ws.getCell(r, 6).value = l.debit_total;
    ws.getCell(r, 7).value = l.credit_total;
    ws.getCell(r, 8).value = l.closing;
    ws.getRow(r).font = { bold: true };
    r += 2;
  }
  for (let c = 6; c <= 8; c++) ws.getColumn(c).numFmt = MONEY;
  ws.getColumn(4).width = 20;
  ws.getColumn(5).width = 30;
}

function writeMonthly(ws: ExcelJS.Worksheet, m: MonthlySummary): void {
  ws.getCell("B2").value = "【各勘定科目の月別・摘要別 集計一覧】";
  const head = ["勘定科目", "摘要", ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`), "年間合計"];
  head.forEach((h, i) => { ws.getCell(4, 2 + i).value = h; });
  ws.getRow(4).font = { bold: true };
  let r = 5;
  ws.getCell(r, 2).value = "売上 (月別)";
  m.monthly_sales.forEach((v, i) => { ws.getCell(r, 4 + i).value = v; });
  ws.getCell(r, 16).value = m.sales_total;
  r += 2;
  for (const a of m.accounts) {
    ws.getCell(r, 2).value = `${a.code} ${a.name}`;
    ws.getCell(r, 3).value = "(合計)";
    a.months.forEach((v, i) => { ws.getCell(r, 4 + i).value = v; });
    ws.getCell(r, 16).value = a.total;
    ws.getRow(r).font = { bold: true };
    r++;
    for (const d of a.by_description) {
      ws.getCell(r, 3).value = d.description;
      d.months.forEach((v, i) => { ws.getCell(r, 4 + i).value = v; });
      ws.getCell(r, 16).value = d.total;
      r++;
    }
  }
  for (let c = 4; c <= 16; c++) ws.getColumn(c).numFmt = MONEY;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 28;
  ws.views = [{ state: "frozen", ySplit: 4 }];
}

function writeReport(ws: ExcelJS.Worksheet, rep: FinancialReport, year: number): void {
  ws.getCell("B2").value = `${year} 年分 損益計算書`;
  ws.getRow(2).font = { bold: true, size: 13 };
  let r = 4;
  ws.getCell(r, 2).value = "科目";
  ws.getCell(r, 3).value = "金額";
  ws.getRow(r).font = { bold: true };
  r++;
  for (const line of rep.pl.revenues) { ws.getCell(r, 2).value = `${line.code} ${line.name}`; ws.getCell(r, 3).value = line.amount; r++; }
  ws.getCell(r, 2).value = "売上 (収入) 金額 合計"; ws.getCell(r, 3).value = rep.pl.sales_total; ws.getRow(r).font = { bold: true }; r += 2;
  for (const line of rep.pl.expenses) { ws.getCell(r, 2).value = `${line.code} ${line.name}`; ws.getCell(r, 3).value = line.amount; r++; }
  ws.getCell(r, 2).value = "経費 合計"; ws.getCell(r, 3).value = rep.pl.expense_total; ws.getRow(r).font = { bold: true }; r++;
  ws.getCell(r, 2).value = "青色申告特別控除前の所得金額"; ws.getCell(r, 3).value = rep.pl.income; ws.getRow(r).font = { bold: true }; r += 3;

  ws.getCell(r, 2).value = `${year} 年分 貸借対照表`;
  ws.getRow(r).font = { bold: true, size: 13 };
  r += 2;
  ["科目 (資産)", "期首", "期末", "", "科目 (負債・資本)", "期首", "期末"].forEach((h, i) => { ws.getCell(r, 2 + i).value = h; });
  ws.getRow(r).font = { bold: true };
  r++;
  const n = Math.max(rep.bs.assets.length, rep.bs.liabilities.length + 1);
  for (let i = 0; i < n; i++) {
    const a = rep.bs.assets[i];
    if (a) { ws.getCell(r + i, 2).value = `${a.code} ${a.name}`; ws.getCell(r + i, 3).value = a.opening; ws.getCell(r + i, 4).value = a.closing; }
    const l = rep.bs.liabilities[i];
    if (l) { ws.getCell(r + i, 6).value = `${l.code} ${l.name}`; ws.getCell(r + i, 7).value = l.opening; ws.getCell(r + i, 8).value = l.closing; }
    else if (i === rep.bs.liabilities.length) { ws.getCell(r + i, 6).value = "青色申告特別控除前の所得金額"; ws.getCell(r + i, 8).value = rep.bs.income; }
  }
  r += n;
  ws.getCell(r, 2).value = "合計"; ws.getCell(r, 3).value = rep.bs.assets_opening_total; ws.getCell(r, 4).value = rep.bs.assets_closing_total;
  ws.getCell(r, 6).value = "合計"; ws.getCell(r, 7).value = rep.bs.liabilities_opening_total; ws.getCell(r, 8).value = rep.bs.liabilities_closing_total + rep.bs.income;
  ws.getRow(r).font = { bold: true };
  for (const c of [3, 4, 7, 8]) ws.getColumn(c).numFmt = MONEY;
  ws.getColumn(2).width = 28;
  ws.getColumn(6).width = 30;
}

/** ③ 減価償却費の計算 と同じ列 (イ〜ヌ)。 */
function writeDepreciation(ws: ExcelJS.Worksheet, d: YearSchedule): void {
  ws.getCell("B2").value = `【減価償却費の計算】 ${d.year} 年`;
  const head = ["減価償却資産の名称等", "面積又は数量", "取得年月", "取得価額 (イ)", "償却の基礎になる金額 (ロ)", "償却方法", "耐用年数",
    "償却率 (ハ)", "本年中の償却期間 (ニ)", "本年分の普通償却費 (ホ)", "割増償却費 (ヘ)", "本年分の償却費合計 (ト)", "事業専用割合 (チ)",
    "本年分の必要経費算入額 (リ)", "未償却残高 (ヌ)", "摘要"];
  head.forEach((h, i) => { ws.getCell(4, 2 + i).value = h; });
  ws.getRow(4).font = { bold: true };
  let r = 5;
  for (const row of d.rows) {
    const vals = [row.name, row.quantity, row.acquired_on.slice(0, 7), row.cost, row.basis, row.method, row.useful_life || null,
      row.rate, row.months, row.ordinary, row.extra, row.total, row.business_ratio, row.expense, row.closing_book, row.notes];
    vals.forEach((v, i) => { ws.getCell(r, 2 + i).value = v; });
    r++;
  }
  ws.getCell(r, 2).value = "合計";
  ws.getCell(r, 11).value = d.totals.ordinary;
  ws.getCell(r, 12).value = d.totals.extra;
  ws.getCell(r, 13).value = d.totals.total;
  ws.getCell(r, 15).value = d.totals.expense;
  ws.getCell(r, 16).value = d.totals.closing_book;
  ws.getRow(r).font = { bold: true };
  for (const c of [5, 6, 11, 12, 13, 15, 16]) ws.getColumn(c).numFmt = MONEY;
  ws.getColumn(9).numFmt = "0.000";
  ws.getColumn(14).numFmt = "0%";
  ws.getColumn(2).width = 28;
}
