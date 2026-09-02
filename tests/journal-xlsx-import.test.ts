import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { JournalEntriesRepo } from "../src/db/journal-entries-repo.js";
import { ApportionmentObservationsRepo } from "../src/db/apportionment-observations-repo.js";
import { parseJournalWorkbook, serialToIso } from "../src/services/bookkeeping/journal-xlsx-import.js";
import { JournalImportService } from "../src/services/bookkeeping/journal-import.js";
import { buildJournalWorkbook, isoToExcelSerial } from "../src/services/excel-export.js";
import { buildBookkeepingWorkbook } from "../src/services/bookkeeping/bookkeeping-workbook.js";
import { computeTrialBalance } from "../src/services/bookkeeping/trial-balance.js";
import { buildFinancialReport } from "../src/services/bookkeeping/financial-report.js";
import { summarizeMonthly } from "../src/services/bookkeeping/monthly-summary.js";
import { assertSafeXlsxArchive, MAX_XLSX_UNCOMPRESSED_BYTES } from "../src/services/bookkeeping/xlsx-archive-limits.js";

/** エクセル簿記そっくりのブック: 5 行目に大見出し、 7 行目に列見出し、 8 行目からデータ。 E/F/H/I は数式 + 結果。 */
async function excelBookkeepingLikeWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const intro = wb.addWorksheet("はじめに");
  intro.getCell("AA7").value = "ｺｰﾄﾞ"; intro.getCell("AB7").value = "勘　定　科　目"; intro.getCell("AC7").value = "分類";
  const accounts: [number, string, string][] = [[1, "売上（収入）金額", "収益"], [26, "ソフトウエア購入費", "費用"], [31, "雑費", "費用"], [102, "当座預金", "資産"], [124, "事業主貸", "資産"], [172, "事業主借", "負債"]];
  accounts.forEach(([code, name, kind], i) => {
    intro.getCell(`AA${8 + i}`).value = { formula: `IF([1]はじめに!$AA${8 + i}="","",[1]はじめに!$AA${8 + i})`, result: code };
    intro.getCell(`AB${8 + i}`).value = name;
    intro.getCell(`AC${8 + i}`).value = kind;
  });
  intro.getCell("AA20").value = "-"; intro.getCell("AB20").value = "-";

  const ws = wb.addWorksheet("仕訳帳");
  ws.getCell("B5").value = "日付"; ws.getCell("C5").value = "№"; ws.getCell("D5").value = "借　　　　方";
  ws.getCell("B7").value = "日付"; ws.getCell("C7").value = "№"; ws.getCell("D7").value = "科目ｺｰﾄﾞ"; ws.getCell("E7").value = "勘定科目";
  ws.getCell("F7").value = "金　　額"; ws.getCell("G7").value = "科目ｺｰﾄﾞ"; ws.getCell("J7").value = "摘要"; ws.getCell("K7").value = "支払"; ws.getCell("L7").value = "按分率";
  const rows: [string, number, number, number, number, string, number, number | "-"][] = [
    ["2025-01-24", 1, 102, 1, 177_228, "バンタン", 177_228, 1],
    ["2025-01-30", 2, 26, 102, 14_679, "NOTION LABS, INC.", 14_679, 1],
    ["2025-02-02", 3, 26, 102, 2_365, "ＮＥＴＦＬＩＸ．ＣＯＭ", 4_730, 0.5],
    ["2025-02-02", 4, 124, 102, 2_365, "クレカ引き落とし調整", 4_730, 0.5],
    ["2025-02-10", 5, 124, 102, 800, "セブンイレブン", 800, "-"],
  ];
  rows.forEach(([date, no, d, c, amount, desc, payment, rate], i) => {
    const r = 8 + i;
    ws.getCell(`B${r}`).value = isoToExcelSerial(date);
    ws.getCell(`C${r}`).value = no;
    ws.getCell(`D${r}`).value = d;
    ws.getCell(`E${r}`).value = { formula: `IF(D${r}="","",VLOOKUP(D${r},勘定科目,2,0))`, result: "x" };
    ws.getCell(`F${r}`).value = { formula: `IF(L${r}<>"-",ROUNDDOWN(K${r}*L${r},0),K${r})`, result: amount };
    ws.getCell(`G${r}`).value = c;
    ws.getCell(`I${r}`).value = { formula: `IF(F${r}="","",F${r})`, result: amount };
    ws.getCell(`J${r}`).value = desc;
    ws.getCell(`K${r}`).value = payment;
    ws.getCell(`L${r}`).value = rate;
    ws.getCell(`N${r}`).value = { formula: `MONTH(B${r})`, result: Number(date.slice(5, 7)) };
  });
  // 末尾の数式だけの空行 (エクセル簿記は 1943 行まで数式が入っている)
  for (const r of [13, 14]) {
    ws.getCell(`E${r}`).value = { formula: `IF(D${r}="","",VLOOKUP(D${r},勘定科目,2,0))`, result: "" };
    ws.getCell(`N${r}`).value = { formula: `MONTH(B${r})`, result: 1 };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("journal xlsx import", () => {
  it("Excel serial と ISO の往復", () => {
    expect(serialToIso(isoToExcelSerial("2025-01-24"))).toBe("2025-01-24");
    expect(serialToIso(45_658)).toBe("2025-01-01");
  });

  it("エクセル簿記のヘッダ行を自動検出し、 数式セルは結果値で読む", async () => {
    const parsed = await parseJournalWorkbook(await excelBookkeepingLikeWorkbook());
    expect(parsed.header_row).toBe(7);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.skipped).toHaveLength(0);
    expect(parsed.rows[0]).toMatchObject({ entry_date: "2025-01-24", debit_code: 102, credit_code: 1, debit_amount: 177_228, description: "バンタン", rate: 1 });
    expect(parsed.rows[2]).toMatchObject({ debit_amount: 2_365, payment: 4_730, rate: 0.5 });
    expect(parsed.rows[4]!.rate).toBe(1); // "-" は按分無し
    expect(parsed.accounts.map((a) => a.code)).toEqual([1, 26, 31, 102, 124, 172]);
    expect(parsed.accounts.find((a) => a.code === 172)!.kind).toBe("liability");
  });

  it("Quaestor 自身の export (6 行目見出し) も読める", async () => {
    const buf = await buildJournalWorkbook([{
      no: 1, date: "2025-03-01", debit_code: 26, debit_name: "ソフトウエア購入費", debit_amount: 100, credit_code: 102, credit_name: "当座預金", credit_amount: 100,
      description: "OPENAI", payment: 100, rate: 1, source_tx_id: "x", leg: "expense", payee: "OPENAI",
    }]);
    const parsed = await parseJournalWorkbook(buf);
    expect(parsed.header_row).toBe(6);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.description).toBe("OPENAI");
  });

  it("仕訳帳シートが無ければ例外", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("other");
    await expect(parseJournalWorkbook(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toThrow(/sheet not found/);
  });

  it("展開後サイズが上限を超える ZIP は ExcelJS に渡す前に拒否する", async () => {
    const buf = Buffer.from(await excelBookkeepingLikeWorkbook());
    const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThanOrEqual(0);
    buf.writeUInt32LE(MAX_XLSX_UNCOMPRESSED_BYTES + 1, central + 24);
    expect(() => assertSafeXlsxArchive(buf)).toThrow(/expanded size limit/);
  });
});

describe("JournalImportService", () => {
  function setup() {
    const db = new Database(":memory:");
    applyMigrations(db);
    const accounts = new AccountCodesRepo(db);
    accounts.seedIfEmpty();
    const entries = new JournalEntriesRepo(db);
    const observations = new ApportionmentObservationsRepo(db);
    return { db, accounts, entries, observations, svc: new JournalImportService({ db, entries, accounts, observations }) };
  }

  it("imported 行として取り込み、 未知の科目を追加し、 観測を作る。 再取込で増えない", async () => {
    const s = setup();
    const parsed = await parseJournalWorkbook(await excelBookkeepingLikeWorkbook());
    const r1 = s.svc.importParsed(parsed);
    expect(r1.fiscal_years).toEqual([2025]);
    expect(r1.inserted).toBe(5);
    expect(r1.accounts_added).toBe(1); // 31 雑費 だけ seed に無い
    expect(s.accounts.find(31)!.name).toBe("雑費");
    // 観測: NOTION (100%/26), NETFLIX (50%/26), セブンイレブン (0%/124)。 調整行と売上は除外
    expect(r1.observations).toBe(3);
    const obs = s.observations.list();
    expect(obs.map((o) => [o.payee_norm, o.rate, o.code])).toEqual(expect.arrayContaining([
      ["NOTION LABS, INC.", 1, 26], ["NETFLIX.COM", 0.5, 26], ["セブンイレブン", 0, 124],
    ]));
    const rows = s.entries.listYear(2025);
    expect(rows.every((e) => e.origin === "imported" && e.locked === 1)).toBe(true);
    expect(rows.map((e) => e.leg)).toEqual(["income", "expense", "expense", "household", "household"]);

    const r2 = s.svc.importParsed(parsed);
    expect(r2.replaced).toBe(5);
    expect(s.entries.listYear(2025)).toHaveLength(5);
    expect(s.observations.count()).toBe(3);
  });

  it("別年度の再取込で既存年度の xlsx 観測を消さない", async () => {
    const s = setup();
    const parsed2025 = await parseJournalWorkbook(await excelBookkeepingLikeWorkbook());
    s.svc.importParsed(parsed2025);
    const parsed2026 = {
      ...parsed2025,
      rows: parsed2025.rows.map((row) => ({ ...row, entry_date: row.entry_date.replace(/^2025-/, "2026-") })),
    };
    s.svc.importParsed(parsed2026);
    expect(s.observations.list().filter((o) => o.source === "journal-xlsx").map((o) => o.fiscal_year))
      .toEqual(expect.arrayContaining([2025, 2026]));
    expect(s.observations.count()).toBe(6);
  });
});

describe("bookkeeping workbook", () => {
  it("5 シートを持ち、 仕訳帳はエクセル簿記と同じ 7 行目見出し・8 行目データ", async () => {
    const accounts = [
      { code: 1, name: "売上", kind: "revenue" as const }, { code: 26, name: "ソフトウエア購入費", kind: "expense" as const },
      { code: 102, name: "当座預金", kind: "asset" as const }, { code: 172, name: "事業主借", kind: "liability" as const },
    ];
    const lines = [
      { id: 1, entry_date: "2025-01-05", no: 1, debit_code: 102, debit_amount: 1_000, credit_code: 1, credit_amount: 1_000, description: "売上" },
      { id: 2, entry_date: "2025-01-06", no: 2, debit_code: 26, debit_amount: 300, credit_code: 102, credit_amount: 300, description: "OPENAI" },
    ];
    const tb = computeTrialBalance(lines, accounts);
    const buf = await buildBookkeepingWorkbook({
      fiscal_year: 2025,
      journal: lines.map((l) => ({ date: l.entry_date, no: l.no, debit_code: l.debit_code, debit_name: "", debit_amount: l.debit_amount, credit_code: l.credit_code, credit_name: "", credit_amount: l.credit_amount, description: l.description, payment: l.debit_amount, rate: 1 })),
      trial_balance: tb,
      ledgers: [],
      monthly: summarizeMonthly(lines, accounts),
      report: buildFinancialReport(tb),
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["仕訳帳", "精算表", "元帳", "月別集計", "決算書"]);
    const j = wb.getWorksheet("仕訳帳")!;
    expect(j.getCell("B7").value).toBe("日付");
    expect(j.getCell("D8").value).toBe(102);
    expect(j.getCell("J9").value).toBe("OPENAI");
    // 取込側で読み戻せる (往復)
    const parsed = await parseJournalWorkbook(buf);
    expect(parsed.header_row).toBe(7);
    expect(parsed.rows).toHaveLength(2);
  });
});
