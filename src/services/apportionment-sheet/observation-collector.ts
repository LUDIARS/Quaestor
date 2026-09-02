/**
 * 按分観測の再構築 (source=ledger)。
 *
 * Quaestor 帳簿のうち「人が決めた」行だけを観測にする:
 *   - origin=manual の経費 / 家計行
 *   - origin=transaction で locked=1 (自動生成を手で直した行)
 * 未編集の自動生成行はルールの写しなので入れない (ルールを自分で裏付ける循環を避ける)。
 * source=journal-xlsx は journal-import が担当する。
 *
 * @implements SPEC-APPORTIONMENT-SHEET-001 (spec/feature/household-bookkeeping.md)
 */

import type { JournalEntriesRepo, JournalEntryRow } from "../../db/journal-entries-repo.js";
import type { ApportionmentObservationsRepo, ObservationInput } from "../../db/apportionment-observations-repo.js";
import { normalizePayee } from "../../shared/text.js";

const HOUSEHOLD_ADJUSTMENT_DESCRIPTION = "クレカ引き落とし調整";
const OWNER_DRAW = 124;

export function isDecidedEntry(e: JournalEntryRow): boolean {
  if (e.leg !== "expense" && e.leg !== "household") return false;
  if (e.origin === "manual") return true;
  return e.origin === "transaction" && e.locked === 1;
}

export function observationFromEntry(e: JournalEntryRow, payeeOf: (e: JournalEntryRow) => string | null): ObservationInput | null {
  const payee = payeeOf(e);
  if (!payee || payee === HOUSEHOLD_ADJUSTMENT_DESCRIPTION) return null;
  const norm = normalizePayee(payee);
  if (!norm) return null;
  // debit_code is the current bookkeeping decision; leg may still describe the
  // originally generated row after a manual reclassification.
  const household = e.debit_code === OWNER_DRAW;
  return {
    fiscal_year: e.fiscal_year,
    payee_norm: norm,
    payee_sample: payee,
    rate: household ? 0 : e.rate,
    code: household ? OWNER_DRAW : e.debit_code,
    amount: e.payment,
    date: e.entry_date,
    source: "ledger",
  };
}

export class ObservationCollector {
  constructor(
    private readonly entries: JournalEntriesRepo,
    private readonly observations: ApportionmentObservationsRepo,
    /** source_tx_id から元取引の payee を引く (家計行の摘要は固定文言のため) */
    private readonly payeeOfTx: (txId: string) => string | null,
  ) {}

  rebuildLedger(): { years: number[]; observations: number } {
    const years = this.entries.years();
    const inputs: ObservationInput[] = [];
    const payeeOf = (e: JournalEntryRow): string | null => {
      if (e.source_tx_id) return this.payeeOfTx(e.source_tx_id) ?? e.description;
      return e.description;
    };
    for (const y of years) {
      for (const e of this.entries.listYear(y)) {
        if (!isDecidedEntry(e)) continue;
        const obs = observationFromEntry(e, payeeOf);
        if (obs) inputs.push(obs);
      }
    }
    this.observations.clearSource("ledger");
    this.observations.addMany(inputs);
    return { years, observations: inputs.length };
  }
}
