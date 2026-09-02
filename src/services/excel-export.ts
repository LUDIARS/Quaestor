/**
 * 仕訳帳 Excel ファイル生成。 calc/2025.xlsx の「仕訳帳」シート互換レイアウト。
 *
 * 列構造 (calc/spec/data/calc-lessons.md 仕訳帳列構造):
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

/** 仕訳帳シートに書く 1 行 (JournalEntry / journal_entries どちらからも作れる最小形)。 */
export interface JournalSheetRow {
  date: string;
  no: number;
  debit_code: number;
  debit_name: string;
  debit_amount: number;
  credit_code: number;
  credit_name: string;
  credit_amount: number;
  description: string;
  payment: number;
  rate: number;
}

export interface JournalSheetOptions {
  /** 見出し行。 Quaestor 既定は 6 (データは 7 から)。 エクセル簿記互換は 7 (データは 8 から) */
  headerRow?: number;
}

/**
 * 既存 worksheet に仕訳帳の列構造 (B..L) を書く。 ブック生成側 (単体 export / 簿記ブック) が共用する。
 */
export function writeJournalSheet(ws: ExcelJS.Worksheet, entries: JournalSheetRow[], opts: JournalSheetOptions = {}): number {
  const header = opts.headerRow ?? 6;
  ws.getCell(`B${header}`).value = "日付";
  ws.getCell(`C${header}`).value = "№";
  ws.getCell(`D${header}`).value = "借方科目コード";
  ws.getCell(`E${header}`).value = "借方勘定科目";
  ws.getCell(`F${header}`).value = "借方金額";
  ws.getCell(`G${header}`).value = "貸方科目コード";
  ws.getCell(`H${header}`).value = "貸方勘定科目";
  ws.getCell(`I${header}`).value = "貸方金額";
  ws.getCell(`J${header}`).value = "摘要";
  ws.getCell(`K${header}`).value = "支払";
  ws.getCell(`L${header}`).value = "按分率";
  ws.getRow(header).font = { bold: true };
  ws.getRow(header).alignment = { horizontal: "center" };

  // 日付列 (B) は数値書式
  ws.getColumn("B").numFmt = "yyyy/m/d";
  ws.getColumn("F").numFmt = "#,##0";
  ws.getColumn("I").numFmt = "#,##0";
  ws.getColumn("K").numFmt = "#,##0";
  ws.getColumn("L").numFmt = "0.00%";
  ws.getColumn("J").width = 30;
  ws.getColumn("E").width = 16;
  ws.getColumn("H").width = 16;

  let row = header + 1;
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
  ws.views = [{ state: "frozen", ySplit: header }];
  return row - 1;
}

export async function buildJournalWorkbook(entries: JournalEntry[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Quaestor";
  wb.created = new Date();
  const ws = wb.addWorksheet("仕訳帳", { properties: { defaultColWidth: 14 } });
  writeJournalSheet(ws, entries, { headerRow: 6 });
  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}
