/**
 * スキャンした明細 (doc_kind='statement') を取引として取り込む。
 *
 * 明細取込ページのスクショ (`smart-import.ts` → `POST /v1/imports/smart-screenshot`) と同じ
 * `ImportedTransaction` に変換し、 同じ `imports` / `transactions` へ入れる。 source_id の算出も
 * 共通 (`statement-rows.ts`) なので、 同じ明細をスキャンと明細取込の両方から入れても 1 件に収束する。
 *
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 */

import type { ImportsRepo } from "../db/imports-repo.js";
import type { ReceiptRow } from "../db/receipts-repo.js";
import type { TransactionsRepo } from "../db/transactions-repo.js";
import type { SourceKind } from "../shared/types.js";
import { statementAccount, statementRowsOf, statementRowsToTransactions } from "./statement-rows.js";

export interface ScanStatementDeps {
  imports: ImportsRepo;
  txs: TransactionsRepo;
}

/**
 * クレカ / 銀行の別は撮影画像からは決められないので、 `smart-import.ts` の既定と同じ
 * `credit-card` で入れる (取込元ラベルは brand `scan-statement` で区別できる)。
 */
const SCAN_STATEMENT_SOURCE: SourceKind = "credit-card";
const SCAN_STATEMENT_BRAND = "scan-statement";

export interface ScanStatementImport {
  import_id: number;
  account: string;
  parsed: number;
  inserted: number;
  duplicates: number;
}

/** 明細行を transactions へ入れる。 全行が既取込なら inserted=0 / duplicates>0 を返す。 */
export function importScanStatement(deps: ScanStatementDeps, r: ReceiptRow): ScanStatementImport {
  const account = statementAccount(r);
  const rows = statementRowsToTransactions(statementRowsOf(r), {
    account,
    metadata: { brand: SCAN_STATEMENT_BRAND, receipt_id: r.id },
  });
  const importId = deps.imports.insert({
    source: SCAN_STATEMENT_SOURCE,
    brand: SCAN_STATEMENT_BRAND,
    account,
    filename: r.image_path,
    metadata: { receipt_id: r.id, parsed_rows: rows.length, scan: true },
  });
  const bulk = deps.txs.insertBulk(
    rows.map((row) => ({ ...row, source: SCAN_STATEMENT_SOURCE, import_id: importId })),
  );
  return {
    import_id: importId,
    account,
    parsed: rows.length,
    inserted: bulk.inserted,
    duplicates: bulk.duplicates,
  };
}
