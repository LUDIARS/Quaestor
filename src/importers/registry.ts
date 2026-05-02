/**
 * Importer レジストリ。 brand 名で取り出すか、 buffer から auto-detect する。
 *
 * v0.1 は UFJ クレカのみ。 brand 追加は本ファイルへの登録だけで完結する。
 */

import type { Importer } from "../shared/types.js";
import { ufjCsvImporter } from "./ufj-csv.js";
import { amazonOrderHistoryImporter } from "./amazon-order-history.js";
import { smbcCsvImporter } from "./smbc-csv.js";
import { smbcBankPdfImporter } from "./smbc-bank-pdf.js";

const IMPORTERS = new Map<string, Importer>([
  ["ufj", ufjCsvImporter],
  ["smbc", smbcCsvImporter],
  ["amazon-order-history", amazonOrderHistoryImporter],
  // smbc-bank は detect のみ。 parse は async API (parseSmbcBankPdf) で実行する
  ["smbc-bank", smbcBankPdfImporter],
]);

export function get(brand: string): Importer | undefined {
  return IMPORTERS.get(brand);
}

export function brands(): string[] {
  return [...IMPORTERS.keys()];
}

/** auto-detect: 先頭にマッチする importer を返す */
export function detect(buf: Buffer): { brand: string; importer: Importer } | null {
  for (const [brand, importer] of IMPORTERS) {
    if (importer.detect(buf)) return { brand, importer };
  }
  return null;
}
