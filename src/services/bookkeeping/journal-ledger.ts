/**
 * 取引 → 仕訳帳 (journal_entries) の永続化。
 *
 * rebuild(year) は origin=transaction かつ locked=0 の行だけを入れ替える。
 * manual / imported / locked の行はそのまま残るので、 取引を追加取込した後に
 * 何度呼んでも手直しは失われない (冪等)。 仕訳の展開ロジックは journal.ts の buildJournal 1 箇所。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-001 (spec/feature/household-bookkeeping.md)
 */

import type Database from "better-sqlite3";
import type { ApportionmentRulesRepo } from "../../db/apportionment-rules-repo.js";
import type { AccountCodesRepo } from "../../db/account-codes-repo.js";
import type { CreateJournalEntryInput, JournalEntriesRepo } from "../../db/journal-entries-repo.js";
import { buildJournal, type AccountCodeMap, type JournalEntry } from "../journal.js";
import type { HouseholdClassifier } from "../household/household-classifier.js";

export interface JournalLedgerDeps {
  db: Database.Database;
  rules: ApportionmentRulesRepo;
  accounts: AccountCodesRepo;
  entries: JournalEntriesRepo;
  classifier: HouseholdClassifier;
}

export interface RebuildResult {
  fiscal_year: number;
  deleted: number;
  generated: number;
  kept_locked: number;
  renumbered: number;
}

export class JournalLedger {
  constructor(private readonly deps: JournalLedgerDeps) {}

  accountNames(): AccountCodeMap {
    const map: AccountCodeMap = {};
    for (const a of this.deps.accounts.list()) map[a.code] = a.name;
    return map;
  }

  /** 年度の自動生成行を取引から作り直す。 */
  rebuild(fiscalYear: number): RebuildResult {
    const generated = buildJournal(this.deps.db, this.deps.rules, {
      date_from: `${fiscalYear}-01-01`,
      date_to: `${fiscalYear}-12-31`,
      accountNames: this.accountNames(),
    });
    const locked = this.deps.entries.lockedGeneratedKeys(fiscalYear);
    let deleted = 0;
    let inserted = 0;
    let keptLocked = 0;
    this.deps.db.transaction(() => {
      deleted = this.deps.entries.deleteGenerated(fiscalYear);
      for (const e of generated) {
        if (locked.has(`${e.source_tx_id}|${e.leg}`)) { keptLocked++; continue; }
        this.deps.entries.insert(this.toInput(fiscalYear, e));
        inserted++;
      }
    })();
    const renumbered = this.deps.entries.renumber(fiscalYear);
    return { fiscal_year: fiscalYear, deleted, generated: inserted, kept_locked: keptLocked, renumbered };
  }

  private toInput(fiscalYear: number, e: JournalEntry): CreateJournalEntryInput {
    const household = e.leg === "household" ? this.deps.classifier.classify(e.payee).category_id : null;
    return {
      fiscal_year: fiscalYear,
      entry_date: e.date,
      debit_code: e.debit_code,
      debit_amount: e.debit_amount,
      credit_code: e.credit_code,
      credit_amount: e.credit_amount,
      description: e.description,
      payment: e.payment,
      rate: e.rate,
      origin: "transaction",
      leg: e.leg,
      source_tx_id: e.source_tx_id,
      household_category_id: household,
    };
  }
}
