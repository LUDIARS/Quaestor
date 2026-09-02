import { describe, it, expect } from "vitest";
import { buildGeneralLedger, type LedgerSourceLine } from "../src/services/bookkeeping/general-ledger.js";
import { summarizeMonthly } from "../src/services/bookkeeping/monthly-summary.js";

const NAMES: Record<number, string> = { 1: "売上", 26: "ソフトウエア購入費", 102: "当座預金", 124: "事業主貸" };
const name = (c: number) => NAMES[c] ?? `(${c})`;

const LINES: LedgerSourceLine[] = [
  { id: 1, entry_date: "2025-01-24", no: 1, debit_code: 102, debit_amount: 100_000, credit_code: 1, credit_amount: 100_000, description: "バンタン" },
  { id: 2, entry_date: "2025-01-30", no: 2, debit_code: 26, debit_amount: 14_679, credit_code: 102, credit_amount: 14_679, description: "NOTION" },
  { id: 3, entry_date: "2025-02-15", no: 3, debit_code: 124, debit_amount: 3_000, credit_code: 102, credit_amount: 3_000, description: "クレカ引き落とし調整" },
  { id: 4, entry_date: "2025-02-28", no: 4, debit_code: 102, debit_amount: 50_000, credit_code: 1, credit_amount: 50_000, description: "MELPOT" },
  { id: 5, entry_date: "2025-03-05", no: 5, debit_code: 26, debit_amount: 1_000, credit_code: 102, credit_amount: 1_000, description: "NOTION" },
];

describe("general ledger (総勘定元帳)", () => {
  it("資産科目は 借方 − 貸方 で残高が動き、 相手科目が付く", () => {
    const gl = buildGeneralLedger(LINES, { code: 102, name: "当座預金", kind: "asset" }, name, 10_000);
    expect(gl.lines.map((l) => l.balance)).toEqual([110_000, 95_321, 92_321, 142_321, 141_321]);
    expect(gl.lines[0]!.counter_name).toBe("売上");
    expect(gl.lines[1]!.counter_code).toBe(26);
    expect(gl.debit_total).toBe(150_000);
    expect(gl.credit_total).toBe(18_679);
    expect(gl.closing).toBe(141_321);
  });

  it("収益科目は 貸方 − 借方 で残高が増える", () => {
    const gl = buildGeneralLedger(LINES, { code: 1, name: "売上", kind: "revenue" }, name);
    expect(gl.lines.map((l) => l.credit)).toEqual([100_000, 50_000]);
    expect(gl.closing).toBe(150_000);
  });

  it("関係ない科目は空の元帳", () => {
    const gl = buildGeneralLedger(LINES, { code: 999, name: "x", kind: "expense" }, name);
    expect(gl.lines).toHaveLength(0);
    expect(gl.closing).toBe(0);
  });
});

describe("monthly summary (月別集計)", () => {
  const accounts = [
    { code: 1, name: "売上", kind: "revenue" as const },
    { code: 26, name: "ソフトウエア購入費", kind: "expense" as const },
    { code: 102, name: "当座預金", kind: "asset" as const },
    { code: 124, name: "事業主貸", kind: "asset" as const },
  ];

  it("月別売上 (②) は売上科目の貸方を月で束ねる", () => {
    const m = summarizeMonthly(LINES, accounts);
    expect(m.monthly_sales.slice(0, 3)).toEqual([100_000, 50_000, 0]);
    expect(m.sales_total).toBe(150_000);
  });

  it("科目 × 月 × 摘要 のピボット (ⅱ)", () => {
    const m = summarizeMonthly(LINES, accounts);
    const soft = m.accounts.find((a) => a.code === 26)!;
    expect(soft.months.slice(0, 3)).toEqual([14_679, 0, 1_000]);
    expect(soft.total).toBe(15_679);
    expect(soft.by_description[0]).toMatchObject({ description: "NOTION", total: 15_679 });
    const bank = m.accounts.find((a) => a.code === 102)!;
    expect(bank.months.slice(0, 3)).toEqual([100_000 - 14_679, 50_000 - 3_000, -1_000]);
  });
});
