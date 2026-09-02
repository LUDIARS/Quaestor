/**
 * エクセル簿記 (calc/2025.xlsx) の「仕訳帳」シートと「はじめに」シートの勘定科目表を読む。 パースのみ (DB には触らない)。
 *
 * 仕訳帳: ヘッダ行を自動検出する。 B が「日付」で D が「コード」を含む行 (エクセル簿記は 7 行目、
 * Quaestor の export は 6 行目)。 データはその次の行から、 B と D が埋まっている行だけ拾う。
 * 列: B 日付 / C № / D 借方コード / F 借方金額 / G 貸方コード / I 貸方金額 / J 摘要 / K 支払 / L 按分率。
 * E・H (科目名) と F・I の数式は結果値を使う。 L が "-" の行は按分無し (F = K) なので rate=1。
 *
 * 勘定科目: 「はじめに」シートの AA (コード) / AB (科目名) / AC (分類)。 分類は 収益・売上原価・費用・資産・負債・資本。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-004 (spec/feature/household-bookkeeping.md)
 */

import ExcelJS from "exceljs";
import type { AccountKind } from "../../db/seed.js";
import { normalizeDate } from "../../shared/text.js";
import { assertSafeXlsxArchive } from "./xlsx-archive-limits.js";

export interface ParsedJournalRow {
  row: number;
  entry_date: string;
  no: number | null;
  debit_code: number;
  debit_amount: number;
  credit_code: number;
  credit_amount: number;
  description: string;
  payment: number;
  rate: number;
}

export interface ParsedAccount {
  code: number;
  name: string;
  kind: AccountKind;
}

export interface ParsedJournalWorkbook {
  sheet_name: string;
  header_row: number;
  rows: ParsedJournalRow[];
  /** 読めなかった行 (行番号と理由) */
  skipped: { row: number; reason: string }[];
  accounts: ParsedAccount[];
}

const JOURNAL_SHEET = "仕訳帳";
const INTRO_SHEET = "はじめに";
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MAX_JOURNAL_ROWS = 20_000;

type Scalar = string | number | Date | null;

/** exceljs のセル値 (数式 / richText / Date / プリミティブ) をスカラーに落とす。 */
export function scalarOf(cell: ExcelJS.Cell): Scalar {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("result" in v) {
      const r = v.result;
      if (r instanceof Date) return r;
      if (typeof r === "number" || typeof r === "string") return r;
      return null;
    }
    if ("text" in v) return typeof v.text === "string" ? v.text : null;
  }
  return null;
}

function asText(v: Scalar): string {
  if (v === null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function asNumber(v: Scalar): number | null {
  if (v === null || v instanceof Date) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = v.replace(/[,，\s]/g, "");
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function serialToIso(serial: number): string {
  return new Date(EXCEL_EPOCH_UTC + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

function asIsoDate(v: Scalar, defaultYear?: number): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return v > 0 ? serialToIso(v) : null;
  return normalizeDate(v, defaultYear);
}

function findHeaderRow(ws: ExcelJS.Worksheet): number | null {
  const limit = Math.min(ws.rowCount, 30);
  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r);
    const b = asText(scalarOf(row.getCell("B")));
    const d = asText(scalarOf(row.getCell("D")));
    if (b === "日付" && /(コード|ｺｰﾄﾞ)/.test(d)) return r;
  }
  return null;
}

function kindOf(label: string): AccountKind | null {
  const s = label.replace(/\s/g, "");
  if (s.includes("収益")) return "revenue";
  if (s.includes("費用") || s.includes("売上原価")) return "expense";
  if (s.includes("資産")) return "asset";
  if (s.includes("負債") || s.includes("資本")) return "liability";
  return null;
}

function parseAccounts(ws: ExcelJS.Worksheet | undefined): ParsedAccount[] {
  if (!ws) return [];
  const out: ParsedAccount[] = [];
  const seen = new Set<number>();
  ws.eachRow((row) => {
    const code = asNumber(scalarOf(row.getCell("AA")));
    const name = asText(scalarOf(row.getCell("AB")));
    const kind = kindOf(asText(scalarOf(row.getCell("AC"))));
    if (code === null || !Number.isInteger(code) || code <= 0 || !name || name === "-" || !kind) return;
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ code, name, kind });
  });
  return out;
}

export async function parseJournalWorkbook(buf: Buffer): Promise<ParsedJournalWorkbook> {
  assertSafeXlsxArchive(buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer, {
    ignoreNodes: ["drawing", "picture", "extLst"],
  });
  const ws = wb.getWorksheet(JOURNAL_SHEET);
  if (!ws) throw new Error(`sheet not found: ${JOURNAL_SHEET}`);
  const header = findHeaderRow(ws);
  if (header === null) throw new Error(`journal header row not found in sheet ${JOURNAL_SHEET}`);
  if (ws.rowCount - header > MAX_JOURNAL_ROWS) throw new Error("journal row limit exceeded");

  const rows: ParsedJournalRow[] = [];
  const skipped: { row: number; reason: string }[] = [];
  for (let r = header + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const dateRaw = scalarOf(row.getCell("B"));
    const debitCode = asNumber(scalarOf(row.getCell("D")));
    if (dateRaw === null && debitCode === null) continue; // 空行 (数式だけの行を含む)
    const date = asIsoDate(dateRaw);
    const creditCode = asNumber(scalarOf(row.getCell("G")));
    const debitAmount = asNumber(scalarOf(row.getCell("F")));
    const creditAmount = asNumber(scalarOf(row.getCell("I")));
    const payment = asNumber(scalarOf(row.getCell("K")));
    const rateRaw = scalarOf(row.getCell("L"));
    if (!date) { skipped.push({ row: r, reason: "date" }); continue; }
    if (debitCode === null || creditCode === null) { skipped.push({ row: r, reason: "code" }); continue; }
    if (debitAmount === null) { skipped.push({ row: r, reason: "amount" }); continue; }
    if (!Number.isInteger(debitCode) || !Number.isInteger(creditCode) || debitCode <= 0 || creditCode <= 0) {
      skipped.push({ row: r, reason: "code" }); continue;
    }
    if (!Number.isInteger(debitAmount) || debitAmount < 0 || creditAmount === null
      || !Number.isInteger(creditAmount) || creditAmount < 0 || debitAmount !== creditAmount) {
      skipped.push({ row: r, reason: "unbalanced amount" }); continue;
    }
    const rateNum = asNumber(rateRaw);
    if (rateNum !== null && (rateNum < 0 || rateNum > 1)) { skipped.push({ row: r, reason: "rate" }); continue; }
    if (payment !== null && (!Number.isInteger(payment) || payment < 0)) { skipped.push({ row: r, reason: "payment" }); continue; }
    const rate = rateNum ?? 1;
    rows.push({
      row: r,
      entry_date: date,
      no: asNumber(scalarOf(row.getCell("C"))),
      debit_code: debitCode,
      debit_amount: Math.round(debitAmount),
      credit_code: creditCode,
      credit_amount: creditAmount,
      description: asText(scalarOf(row.getCell("J"))),
      payment: Math.round(payment ?? debitAmount),
      rate,
    });
  }

  return {
    sheet_name: JOURNAL_SHEET,
    header_row: header,
    rows,
    skipped,
    accounts: parseAccounts(wb.getWorksheet(INTRO_SHEET)),
  };
}
