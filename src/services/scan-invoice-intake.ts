/**
 * スキャンした請求書 (doc_kind='invoice') を受領書類へ合流させる。
 *
 * メール取込 (`mail-intake-service.ts`) は添付 PDF を `PdfExtraction` に起こして
 * `inbound_documents` に載せ、 そこから receipt を作って投入する。 スキャンは receipt が先にあるので
 * 逆向きだが、 **受領書類の形 (`PdfExtraction`) と台帳 (`inbound_documents`) は同じものを使う**。
 * 請求書の受け皿を 2 つ持たないため、 抽出結果の形はここで寄せるだけにする。
 *
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 */

import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { InboundDocumentsRepo } from "../db/inbound-documents-repo.js";
import type { ReceiptRow } from "../db/receipts-repo.js";
import type { PdfExtraction } from "../mail/pdf-extract.js";
import { invoiceFields } from "../shared/receipt-kind-fields.js";
import type { ReceiptStorage } from "./receipt-storage.js";

export interface ScanInvoiceDeps {
  documents: InboundDocumentsRepo;
  /** 画像サイズを台帳に載せるために使う。 未設定なら size=0 で登録する */
  storage?: ReceiptStorage;
}

/** 請求書の発行者。 `kind_fields.issuer` を優先し、 無ければ OCR の payee。 */
export function invoiceIssuer(r: Pick<ReceiptRow, "doc_kind" | "kind_fields" | "payee">): string | null {
  const issuer = invoiceFields(r.doc_kind, r.kind_fields)?.issuer?.trim();
  if (issuer) return issuer;
  const payee = r.payee?.trim();
  return payee || null;
}

/**
 * receipt 行 + `kind_fields` を、 メール取込と同じ `PdfExtraction` の形にする。
 * confidence の条件も `extractInvoiceText` と揃える (発行者・日付・金額が揃えば high)。
 */
export function invoiceExtraction(r: ReceiptRow): PdfExtraction {
  const f = invoiceFields(r.doc_kind, r.kind_fields);
  const issuer = invoiceIssuer(r);
  return {
    issuer,
    date: r.date,
    total: r.total,
    due_date: f?.due_date ?? null,
    invoice_no: f?.invoice_no ?? null,
    confidence: issuer && r.date && r.total !== null && r.total > 0 ? "high" : "low",
  };
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function mimeOf(relativePath: string | null): string {
  return MIME_BY_EXT[extname(relativePath ?? "").toLowerCase()] ?? "application/octet-stream";
}

function sizeOf(deps: ScanInvoiceDeps, relativePath: string | null): number {
  if (!deps.storage || !relativePath) return 0;
  try {
    return statSync(deps.storage.resolve(relativePath)).size;
  } catch {
    return 0; // 画像が消えていても受領登録は続ける (台帳のサイズは表示用)
  }
}

export interface ScanInvoiceRegistration {
  document_id: string;
  extraction: PdfExtraction;
}

/**
 * 請求書を受領書類へ登録する。 既に同じ receipt から登録済ならその行を返す (再投入で二重にしない)。
 * status は 'committed' (receipt を投入する直前に呼ぶ)。
 */
export function registerScanInvoice(deps: ScanInvoiceDeps, r: ReceiptRow): ScanInvoiceRegistration {
  const extraction = invoiceExtraction(r);
  const existing = deps.documents.findByReceipt(r.id);
  if (existing) return { document_id: existing.id, extraction };

  const documentId = deps.documents.insert({
    source: "scan",
    message_id: null,
    filename: basename(r.image_path ?? `${r.id}.jpg`),
    mime_type: mimeOf(r.image_path),
    file_path: r.image_path ?? "",
    sha256: null,
    size: sizeOf(deps, r.image_path),
    extracted: JSON.stringify(extraction),
    status: "committed",
    receipt_id: r.id,
  });
  return { document_id: documentId, extraction };
}
