/**
 * 年度の減価償却を仕訳帳へ計上する (直接法)。
 *
 *   借方 <expense_code> 減価償却費 (経費算入額) / 貸方 <asset_code>
 *   借方 124 事業主貸 (家計分)              / 貸方 <asset_code>   (事業専用割合 < 100% のとき)
 *
 * 行は origin=manual + asset_id で識別し、 同じ年を再計上すると入れ替わる (冪等)。
 * 必要な科目 (18 減価償却費 / 111〜116 資産 / 124 事業主貸) が account_codes に無ければ足す。
 *
 * @implements SPEC-DEPRECIATION-003 (spec/feature/depreciation.md)
 */

import type Database from "better-sqlite3";
import type { AccountCodesRepo } from "../../db/account-codes-repo.js";
import type { CreateJournalEntryInput, JournalEntriesRepo } from "../../db/journal-entries-repo.js";
import type { HouseholdClassifier } from "../household/household-classifier.js";
import type { DepreciationSchedule, ScheduleRow } from "./depreciation-schedule.js";

export interface DepreciationPostingDeps {
  db: Database.Database;
  entries: JournalEntriesRepo;
  accounts: AccountCodesRepo;
  schedule: DepreciationSchedule;
  classifier: HouseholdClassifier;
}

export interface PostingResult {
  fiscal_year: number;
  deleted: number;
  posted: number;
  assets: number;
  accounts_added: number;
}

const OWNER_DRAW = 124;

/** エクセル簿記の標準科目のうち減価償却に要るもの。 seed に無いので必要時に足す。 */
export const DEPRECIATION_ACCOUNTS: { code: number; name: string; kind: "expense" | "asset" }[] = [
  { code: 18, name: "減価償却費", kind: "expense" },
  { code: 111, name: "建物", kind: "asset" },
  { code: 112, name: "建物付属設備", kind: "asset" },
  { code: 113, name: "機械装置", kind: "asset" },
  { code: 114, name: "車両運搬具", kind: "asset" },
  { code: 115, name: "備品", kind: "asset" },
  { code: 116, name: "土地", kind: "asset" },
  { code: OWNER_DRAW, name: "事業主貸", kind: "asset" },
];

export function yearEndDate(year: number): string {
  return `${year}-12-31`;
}

export class DepreciationPosting {
  constructor(private readonly deps: DepreciationPostingDeps) {}

  ensureAccounts(): number {
    let added = 0;
    for (const a of DEPRECIATION_ACCOUNTS) {
      if (this.deps.accounts.find(a.code)) continue;
      this.deps.accounts.upsert(a);
      added++;
    }
    return added;
  }

  entriesFor(year: number, row: ScheduleRow): CreateJournalEntryInput[] {
    if (row.total <= 0) return [];
    const base = {
      fiscal_year: year,
      entry_date: yearEndDate(year),
      payment: row.total,
      origin: "manual" as const,
      asset_id: row.asset_id,
      locked: true,
    };
    const out: CreateJournalEntryInput[] = [];
    if (row.expense > 0) {
      out.push({
        ...base,
        debit_code: row.expense_code, debit_amount: row.expense, credit_code: row.asset_code, credit_amount: row.expense,
        description: `減価償却費 ${row.name}`, rate: row.business_ratio, leg: "expense",
      });
    }
    if (row.household > 0) {
      out.push({
        ...base,
        debit_code: OWNER_DRAW, debit_amount: row.household, credit_code: row.asset_code, credit_amount: row.household,
        description: `減価償却費 (家計分) ${row.name}`, rate: row.business_ratio, leg: "household",
        household_category_id: this.deps.classifier.classify(row.name).category_id,
      });
    }
    return out;
  }

  private validateAccountKinds(rows: ScheduleRow[]): void {
    const assertKind = (code: number, kind: "expense" | "asset"): void => {
      const account = this.deps.accounts.find(code);
      if (!account) throw new Error(`account code ${code} does not exist`);
      if (account.kind !== kind) throw new Error(`account code ${code} must be ${kind}`);
    };
    for (const row of rows) {
      if (row.total <= 0) continue;
      assertKind(row.asset_code, "asset");
      if (row.expense > 0) assertKind(row.expense_code, "expense");
      if (row.household > 0) assertKind(OWNER_DRAW, "asset");
    }
  }

  post(year: number): PostingResult {
    const schedule = this.deps.schedule.forYear(year);
    const inputs = schedule.rows.flatMap((r) => this.entriesFor(year, r));
    let accountsAdded = 0;
    let deleted = 0;
    this.deps.db.transaction(() => {
      accountsAdded = this.ensureAccounts();
      this.validateAccountKinds(schedule.rows);
      deleted = this.deps.entries.deleteAssetEntries(year);
      this.deps.entries.insertMany(inputs);
      this.deps.entries.renumber(year);
    })();
    return { fiscal_year: year, deleted, posted: inputs.length, assets: schedule.rows.filter((r) => r.total > 0).length, accounts_added: accountsAdded };
  }
}
