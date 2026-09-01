import { normalizeDate } from "../shared/text.js";

export interface PdfExtraction {
  issuer: string | null;
  date: string | null;
  total: number | null;
  due_date: string | null;
  invoice_no: string | null;
  confidence: "high" | "low";
}

/** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
export function extractInvoiceText(text: string, issuer: string | null): PdfExtraction {
  const normalizedIssuer = issuer?.trim() || null;
  const dueDate = matchDate(
    text,
    /(?:支払期限|お支払期日|Due(?: Date)?)\s*[:：]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2})/i,
  );
  const labeledDate = matchDate(
    text,
    /(?:発行日|請求日)\s*[:：]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2})/,
  );
  // A lone due date must not be mistaken for an issue date and auto-committed.
  const date = labeledDate ?? (dueDate ? null : matchDate(text, /(\d{4}[/-]\d{1,2}[/-]\d{1,2})/));
  const total = matchAmount(
    text,
    /(?:合計|請求金額|ご請求額|\bTotal\b|\bAmount Due\b)[^\d]{0,20}([\d,]+)/i,
  );
  const invoiceNumber = text.match(
    /(?:請求書番号|Invoice\s*#|No\.)\s*[:：#]?\s*([A-Za-z0-9-]+)/i,
  )?.[1] ?? null;

  return {
    issuer: normalizedIssuer,
    date,
    total,
    due_date: dueDate,
    invoice_no: invoiceNumber,
    confidence: normalizedIssuer && date && total !== null && total > 0 ? "high" : "low",
  };
}

/** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
export async function extractInvoicePdf(
  data: Buffer,
  issuer: string | null,
): Promise<PdfExtraction> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText();
    return extractInvoiceText(parsed.text ?? "", issuer);
  } finally {
    await parser.destroy();
  }
}

function matchDate(text: string, pattern: RegExp): string | null {
  const value = text.match(pattern)?.[1];
  return value ? normalizeDate(value) : null;
}

function matchAmount(text: string, pattern: RegExp): number | null {
  const value = text.match(pattern)?.[1];
  if (!value) return null;
  const amount = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(amount) ? amount : null;
}
