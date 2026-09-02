/**
 * 年度の帳簿集計の façade。 仕訳帳 (journal_entries) を読み、 精算表 / 元帳 / 月別集計 / 決算書 / ブックを組む。
 * 各集計は純関数 (trial-balance.ts 等) に委ね、 ここは「年度のデータを集めて渡す」だけ。
 *
 * 期首残高は financial_statements の section='opening' (label = 科目コード、 amount = 残高) から読む。
 * 資産は借方残高、 負債・資本は貸方残高として扱う。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-003 (spec/feature/household-bookkeeping.md)
 */

import type Database from "better-sqlite3";
import type { AccountCodesRepo } from "../../db/account-codes-repo.js";
import type { JournalEntriesRepo, JournalEntryRow } from "../../db/journal-entries-repo.js";
import type { FinancialStatementsRepo } from "../../db/financial-statements-repo.js";
import type { JournalSheetRow } from "../excel-export.js";
import { computeTrialBalance, type OpeningBalance, type TrialBalance } from "./trial-balance.js";
import { buildGeneralLedger, type GeneralLedger } from "./general-ledger.js";
import { summarizeMonthly, type MonthlySummary } from "./monthly-summary.js";
import { buildFinancialReport, type FinancialReport } from "./financial-report.js";
import { buildBookkeepingWorkbook } from "./bookkeeping-workbook.js";

export const OPENING_SECTION = "opening" as const;

export interface OpeningInput {
  code: number;
  amount: number;
}

export interface BookkeepingReportsDeps {
  db: Database.Database;
  entries: JournalEntriesRepo;
  accounts: AccountCodesRepo;
  fs: FinancialStatementsRepo;
}

export class BookkeepingReports {
  constructor(private readonly deps: BookkeepingReportsDeps) {}

  private accountName(): (code: number) => string {
    const map = new Map(this.deps.accounts.list().map((a) => [a.code, a.name]));
    return (code) => map.get(code) ?? `(unknown ${code})`;
  }

  /** 期首残高 (科目コード → 借方 / 貸方) */
  opening(year: number): Map<number, OpeningBalance> {
    const kinds = new Map(this.deps.accounts.list().map((a) => [a.code, a.kind]));
    const out = new Map<number, OpeningBalance>();
    for (const row of this.deps.fs.findYear(year)) {
      if (row.section !== OPENING_SECTION || row.amount === null) continue;
      const code = Number(row.label);
      if (!Number.isInteger(code)) continue;
      const kind = kinds.get(code);
      if (kind === "asset") out.set(code, { debit: row.amount, credit: 0 });
      else if (kind === "liability") out.set(code, { debit: 0, credit: row.amount });
    }
    return out;
  }

  openingList(year: number): OpeningInput[] {
    return [...this.opening(year).entries()].map(([code, b]) => ({ code, amount: b.debit || b.credit }));
  }

  setOpening(year: number, balances: OpeningInput[]): number {
    let n = 0;
    this.deps.db.transaction(() => {
      this.deps.fs.clearSection(year, OPENING_SECTION);
      for (const b of balances) {
        this.deps.fs.upsert({ year, section: OPENING_SECTION, label: String(b.code), amount: b.amount, display_order: b.code, source: "manual" });
        n++;
      }
    })();
    return n;
  }

  journal(year: number): JournalEntryRow[] {
    return this.deps.entries.listYear(year);
  }

  journalSheetRows(year: number): JournalSheetRow[] {
    const name = this.accountName();
    return this.journal(year).map((e) => ({
      date: e.entry_date, no: e.no,
      debit_code: e.debit_code, debit_name: name(e.debit_code), debit_amount: e.debit_amount,
      credit_code: e.credit_code, credit_name: name(e.credit_code), credit_amount: e.credit_amount,
      description: e.description, payment: e.payment, rate: e.rate,
    }));
  }

  trialBalance(year: number): TrialBalance {
    return computeTrialBalance(this.journal(year), this.deps.accounts.list(), this.opening(year));
  }

  ledger(year: number, code: number): GeneralLedger | null {
    const account = this.deps.accounts.find(code);
    if (!account) return null;
    const op = this.opening(year).get(code);
    const openingValue = op ? (account.kind === "asset" ? op.debit : op.credit) : 0;
    return buildGeneralLedger(this.journal(year), account, this.accountName(), openingValue);
  }

  ledgers(year: number): GeneralLedger[] {
    const lines = this.journal(year);
    const opening = this.opening(year);
    const name = this.accountName();
    return this.deps.accounts.list().map((a) => {
      const op = opening.get(a.code);
      const openingValue = op ? (a.kind === "asset" ? op.debit : op.credit) : 0;
      return buildGeneralLedger(lines, a, name, openingValue);
    });
  }

  monthly(year: number): MonthlySummary {
    return summarizeMonthly(this.journal(year), this.deps.accounts.list());
  }

  report(year: number): FinancialReport {
    return buildFinancialReport(this.trialBalance(year));
  }

  async workbook(year: number): Promise<Buffer> {
    return buildBookkeepingWorkbook({
      fiscal_year: year,
      journal: this.journalSheetRows(year),
      trial_balance: this.trialBalance(year),
      ledgers: this.ledgers(year),
      monthly: this.monthly(year),
      report: this.report(year),
    });
  }
}
