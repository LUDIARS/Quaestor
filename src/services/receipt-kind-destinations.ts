/**
 * 書類種別ごとの投入先。 「何が揃えば投入できるか」 と 「投入したら何処へ流すか」 を種別ごとに 1 つ置く。
 *
 * 投入の可否そのもの (種別方針 → 完備 → 重複 → 投入) は `receipt-commit.ts` が判断し、
 * ここは判断された後の配送先だけを持つ。 配送先はすべて既存の受け皿に合流させる:
 *
 *   receipt / handwritten : receipts (副作用なし)
 *   invoice               : inbound_documents (メール取込と同じ受領書類)   → `scan-invoice-intake.ts`
 *   utility               : cost_rules (水道光熱費ビューの入力)            → `cost-structure/utility-supplier-rules.ts`
 *   statement             : imports + transactions (明細取込と同じ取引)     → `scan-statement-intake.ts`
 *   other                 : 投入先なし (null)
 *
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 */

import type Database from "better-sqlite3";
import type { CostRulesRepo } from "../db/cost-rules-repo.js";
import type { ImportsRepo } from "../db/imports-repo.js";
import type { InboundDocumentsRepo } from "../db/inbound-documents-repo.js";
import type { ReceiptRow } from "../db/receipts-repo.js";
import type { TransactionsRepo } from "../db/transactions-repo.js";
import { DOC_KIND_INFO, type CommitPolicy, type DocKind } from "../shared/document-kinds.js";
import { utilityFields } from "../shared/receipt-kind-fields.js";
import { ensureUtilitySupplierRule } from "./cost-structure/utility-supplier-rules.js";
import type { ReceiptStorage } from "./receipt-storage.js";
import { invoiceIssuer, registerScanInvoice } from "./scan-invoice-intake.js";
import { importScanStatement } from "./scan-statement-intake.js";
import { statementRowsOf } from "./statement-rows.js";

/** 投入先 1 つ分。 `deliver` は投入 (committed_at) の直前に呼ばれる。 */
export interface KindDelivery {
  /** 投入に必要な項目のうち欠けているもの。 空配列 = 完備 */
  missing(r: ReceiptRow): string[];
  /** 投入先へ流し、 API / ログに残す結果を返す */
  deliver(r: ReceiptRow): Record<string, unknown>;
}

export interface KindDestinations {
  /** その種別の投入先。 null = 投入先が無い (`other`) */
  for(kind: DocKind): KindDelivery | null;
  /** 配送と投入を 1 つの単位にまとめる (配送だけ済んで未投入、 を作らない) */
  atomic<T>(fn: () => T): T;
}

/** date / payee / total の欠落。 receipts へ入れる種別が共通で使う。 */
export function missingReceiptFields(r: ReceiptRow): string[] {
  const missing: string[] = [];
  if (!r.date) missing.push("date");
  if (!r.payee || !r.payee.trim()) missing.push("payee");
  if (r.total == null) missing.push("total");
  return missing;
}

/** receipts へ入れるだけの投入先 (receipt / handwritten)。 */
const RECEIPTS_DELIVERY: KindDelivery = {
  missing: missingReceiptFields,
  deliver: () => ({}),
};

/**
 * 投入先を渡さずに `commitReceipt` を呼んだときの既定。 receipts へ入れるだけの種別
 * (receipt / handwritten) しか扱えない。
 */
export const RECEIPTS_ONLY_DESTINATIONS: KindDestinations = {
  for: (kind) => (receiptsOnlyPolicy(kind) ? RECEIPTS_DELIVERY : null),
  atomic: (fn) => fn(),
};

function receiptsOnlyPolicy(kind: DocKind): boolean {
  const policy = DOC_KIND_INFO[kind]?.commitPolicy;
  return policy === "receipt_rules" || policy === "manual_only";
}

export interface KindDestinationDeps {
  db: Database.Database;
  documents: InboundDocumentsRepo;
  costRules: CostRulesRepo;
  imports: ImportsRepo;
  txs: TransactionsRepo;
  /** 受領書類に画像サイズを載せるために使う */
  storage?: ReceiptStorage;
  /** cost_rules の note に残す日付。 既定は今日 */
  today?: () => string;
}

function invoiceDelivery(deps: KindDestinationDeps): KindDelivery {
  return {
    missing(r) {
      const missing: string[] = [];
      if (!r.date) missing.push("date");
      if (r.total == null) missing.push("total");
      if (!invoiceIssuer(r)) missing.push("issuer");
      return missing;
    },
    deliver(r) {
      const { document_id, extraction } = registerScanInvoice(
        { documents: deps.documents, storage: deps.storage },
        r,
      );
      return { document_id, issuer: extraction.issuer, due_date: extraction.due_date, invoice_no: extraction.invoice_no };
    },
  };
}

function utilityDelivery(deps: KindDestinationDeps): KindDelivery {
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  return {
    missing(r) {
      const missing: string[] = [];
      if (!r.date) missing.push("date");
      if (r.total == null) missing.push("total");
      const f = utilityFields(r.doc_kind, r.kind_fields);
      if (!f?.supplier?.trim() && !r.payee?.trim()) missing.push("supplier");
      return missing;
    },
    deliver(r) {
      const f = utilityFields(r.doc_kind, r.kind_fields);
      const outcome = ensureUtilitySupplierRule(deps.costRules, {
        supplier: f?.supplier ?? null,
        payee: r.payee,
        usage: f?.usage ?? null,
        today: today(),
      });
      return outcome.applied
        ? { cost_rule_id: outcome.rule_id, utility: outcome.utility, rule_created: outcome.created }
        : { cost_rule_id: null, utility: null, reason: outcome.reason };
    },
  };
}

function statementDelivery(deps: KindDestinationDeps): KindDelivery {
  return {
    // 明細は 1 枚の合計を持たないので date / payee / total は要らない。 取り込める行があれば投入する
    missing: (r) => (statementRowsOf(r).length > 0 ? [] : ["rows"]),
    deliver: (r) => ({ ...importScanStatement({ imports: deps.imports, txs: deps.txs }, r) }),
  };
}

/**
 * アプリ用の投入先一式。 種別 → 投入先の対応は `DOC_KIND_INFO[kind].commitPolicy` から引く
 * (語彙 / web の説明文と実装が別々に動かないよう、 切替点を 1 つにする)。 `not_wired` だけ null。
 */
export function createKindDestinations(deps: KindDestinationDeps): KindDestinations {
  const byPolicy: Record<CommitPolicy, KindDelivery | null> = {
    receipt_rules: RECEIPTS_DELIVERY,
    manual_only: RECEIPTS_DELIVERY,
    invoice_intake: invoiceDelivery(deps),
    utility_cost: utilityDelivery(deps),
    statement_import: statementDelivery(deps),
    not_wired: null,
  };
  return {
    for: (kind) => byPolicy[DOC_KIND_INFO[kind]?.commitPolicy ?? "not_wired"],
    atomic: (fn) => deps.db.transaction(fn)(),
  };
}
