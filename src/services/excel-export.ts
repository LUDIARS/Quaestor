/**
 * 仕訳帳 Excel ファイル生成。 calc/2025.xlsx の「仕訳帳」シート互換レイアウト。
 *
 * 列構造 (calc/spec/calc-lessons.md 仕訳帳列構造):
 *   B: 日付 (Excel シリアル)
 *   C: 仕訳番号
 *   D: 借方科目コード
 *   E: 借方勘定科目
 *   F: 借方金額
 *   G: 貸方科目コード
 *   H: 貸方勘定科目
 *   I: 貸方金額
 *   J: 摘要
 *   K: 支払 (計算用)
 *   L: 按分率
 *
 * データは row 7 から (header / 集計領域を 1〜6 に空ける、 calc 慣習)。
 */

import ExcelJS from "exceljs";
import type { JournalEntry } from "./journal.js";

/**
 * ISO yyyy-mm-dd → Excel serial date (1899-12-30 起点)
 */
export function isoToExcelSerial(iso: string): number {
  const dt = new Date(iso + "T00:00:00Z");
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((dt.getTime() - epoch) / 86_400_000);
}

export async function buildJournalWorkbook(entries: JournalEntry[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Quaestor";
  wb.created = new Date();
  const ws = wb.addWorksheet("仕訳帳", { properties: { defaultColWidth: 14 } });

  // header (row 6 を見出し、 row 7 からデータ — calc 慣習)
  ws.getCell("B6").value = "日付";
  ws.getCell("C6").value = "№";
  ws.getCell("D6").value = "借方科目コード";
  ws.getCell("E6").value = "借方勘定科目";
  ws.getCell("F6").value = "借方金額";
  ws.getCell("G6").value = "貸方科目コード";
  ws.getCell("H6").value = "貸方勘定科目";
  ws.getCell("I6").value = "貸方金額";
  ws.getCell("J6").value = "摘要";
  ws.getCell("K6").value = "支払";
  ws.getCell("L6").value = "按分率";
  ws.getRow(6).font = { bold: true };
  ws.getRow(6).alignment = { horizontal: "center" };

  // 日付列 (B) は数値書式
  ws.getColumn("B").numFmt = "yyyy/m/d";
  ws.getColumn("F").numFmt = "#,##0";
  ws.getColumn("I").numFmt = "#,##0";
  ws.getColumn("K").numFmt = "#,##0";
  ws.getColumn("L").numFmt = "0.00%";
  ws.getColumn("J").width = 30;
  ws.getColumn("E").width = 16;
  ws.getColumn("H").width = 16;

  let row = 7;
  for (const e of entries) {
    ws.getCell(`B${row}`).value = isoToExcelSerial(e.date);
    ws.getCell(`C${row}`).value = e.no;
    ws.getCell(`D${row}`).value = e.debit_code;
    ws.getCell(`E${row}`).value = e.debit_name;
    ws.getCell(`F${row}`).value = e.debit_amount;
    ws.getCell(`G${row}`).value = e.credit_code;
    ws.getCell(`H${row}`).value = e.credit_name;
    ws.getCell(`I${row}`).value = e.credit_amount;
    ws.getCell(`J${row}`).value = e.description;
    ws.getCell(`K${row}`).value = e.payment;
    ws.getCell(`L${row}`).value = e.rate;
    row++;
  }

  // freeze header
  ws.views = [{ state: "frozen", ySplit: 6 }];

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}
