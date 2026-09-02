/**
 * パース済みの仕訳帳 (journal-xlsx-import) を journal_entries (origin=imported) と
 * apportionment_observations (source=journal-xlsx) へ反映する。
 *
 * 取込は年度単位で置換 (同じブックを 2 回入れても増えない)。 勘定科目表に未知のコードがあれば
 * account_codes に追加する (既存は触らない)。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-004 (spec/feature/household-bookkeeping.md)
 */

import type Database from "better-sqlite3";
import type { AccountCodesRepo } from "../../db/account-codes-repo.js";
import type { CreateJournalEntryInput, JournalEntriesRepo, JournalLeg } from "../../db/journal-entries-repo.js";
import type { ApportionmentObservationsRepo, ObservationInput } from "../../db/apportionment-observations-repo.js";
import { isIsoDate, normalizePayee } from "../../shared/text.js";
import { CODE } from "./manual-entries.js";
import type { ParsedJournalRow, ParsedJournalWorkbook } from "./journal-xlsx-import.js";

export interface JournalImportDeps {
  db: Database.Database;
  entries: JournalEntriesRepo;
  accounts: AccountCodesRepo;
  observations: ApportionmentObservationsRepo;
}

export interface JournalImportOptions {
  /** 既存の imported 行を消してから入れる (既定 true) */
  replace?: boolean;
  /** 勘定科目表を account_codes に反映する (既定 true) */
  import_accounts?: boolean;
}

export interface JournalImportResult {
  fiscal_years: number[];
  inserted: number;
  replaced: number;
  skipped: number;
  accounts_added: number;
  observations: number;
}

/** 家計行の固定摘要。 観測 (店名) としては使えないので除外する。 */
const HOUSEHOLD_ADJUSTMENT_DESCRIPTION = "クレカ引き落とし調整";

export function legOf(row: Pick<ParsedJournalRow, "debit_code" | "credit_code">): JournalLeg | null {
  if (row.debit_code === CODE.OWNER_DRAW) return "household";
  if (row.credit_code === CODE.SALES) return "income";
  if (row.credit_code === CODE.BANK || row.credit_code === CODE.CASH) return "expense";
  return null;
}

export class JournalImportService {
  constructor(private readonly deps: JournalImportDeps) {}

  importParsed(parsed: ParsedJournalWorkbook, opts: JournalImportOptions = {}): JournalImportResult {
    const replace = opts.replace ?? true;
    const importAccounts = opts.import_accounts ?? true;
    const years = [...new Set(parsed.rows.map((r) => Number(r.entry_date.slice(0, 4))))].sort();
    const knownCodes = new Set(this.deps.accounts.list().map((a) => a.code));
    if (importAccounts) for (const a of parsed.accounts) knownCodes.add(a.code);
    for (const row of parsed.rows) {
      if (!isIsoDate(row.entry_date)) throw new Error(`invalid entry date at row ${row.row}`);
      if (!Number.isInteger(row.debit_amount) || row.debit_amount < 0
        || !Number.isInteger(row.credit_amount) || row.credit_amount < 0
        || row.debit_amount !== row.credit_amount) {
        throw new Error(`unbalanced entry at row ${row.row}`);
      }
      if (!knownCodes.has(row.debit_code) || !knownCodes.has(row.credit_code)) {
        throw new Error(`unknown account code at row ${row.row}`);
      }
    }

    let accountsAdded = 0;

    const inputs: CreateJournalEntryInput[] = [];
    const observations: ObservationInput[] = [];
    for (const r of parsed.rows) {
      const leg = legOf(r);
      inputs.push({
        fiscal_year: Number(r.entry_date.slice(0, 4)),
        entry_date: r.entry_date,
        no: r.no ?? 0,
        debit_code: r.debit_code,
        debit_amount: r.debit_amount,
        credit_code: r.credit_code,
        credit_amount: r.credit_amount,
        description: r.description,
        payment: r.payment,
        rate: r.rate,
        origin: "imported",
        leg,
        locked: true,
      });
      const obs = observationOf(r, leg);
      if (obs) observations.push(obs);
    }

    let replaced = 0;
    this.deps.db.transaction(() => {
      if (importAccounts) {
        for (const a of parsed.accounts) {
          if (this.deps.accounts.find(a.code)) continue;
          this.deps.accounts.upsert(a);
          accountsAdded++;
        }
      }
      if (replace) {
        for (const y of years) replaced += this.deps.entries.deleteImported(y);
        this.deps.observations.clearSource("journal-xlsx", years);
      }
      this.deps.entries.insertMany(inputs);
      this.deps.observations.addMany(observations);
      for (const y of years) this.deps.entries.renumber(y);
    })();

    return {
      fiscal_years: years,
      inserted: inputs.length,
      replaced,
      skipped: parsed.skipped.length,
      accounts_added: accountsAdded,
      observations: observations.length,
    };
  }
}

function observationOf(r: ParsedJournalRow, leg: JournalLeg | null): ObservationInput | null {
  if (leg !== "expense" && leg !== "household") return null;
  if (!r.description || r.description === HOUSEHOLD_ADJUSTMENT_DESCRIPTION) return null;
  const norm = normalizePayee(r.description);
  if (!norm) return null;
  const isHousehold = leg === "household";
  return {
    fiscal_year: Number(r.entry_date.slice(0, 4)),
    payee_norm: norm,
    payee_sample: r.description,
    rate: isHousehold ? 0 : r.rate,
    code: isHousehold ? CODE.OWNER_DRAW : r.debit_code,
    amount: r.payment,
    date: r.entry_date,
    source: "journal-xlsx",
  };
}
