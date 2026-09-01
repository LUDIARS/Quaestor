import { describe, expect, it } from "vitest";
import { extractInvoiceText } from "../src/mail/pdf-extract.js";

describe("extractInvoiceText", () => {
  it("extracts complete Japanese invoice values", () => {
    expect(extractInvoiceText(
      "発行日: 2026/09/01 支払期限: 2026/09/30 合計 ¥12,345 請求書番号: INV-1",
      "Example",
    )).toMatchObject({
      issuer: "Example",
      date: "2026-09-01",
      due_date: "2026-09-30",
      total: 12345,
      invoice_no: "INV-1",
      confidence: "high",
    });
  });

  it("does not mark invalid calendar dates or zero totals as high confidence", () => {
    expect(extractInvoiceText("発行日: 2026/02/30 合計 ¥1,000", "Example")).toMatchObject({
      date: null,
      confidence: "low",
    });
    expect(extractInvoiceText("発行日: 2026/02/28 合計 ¥0", "Example")).toMatchObject({
      total: 0,
      confidence: "low",
    });
  });

  it("does not confuse a due date or subtotal with the issue date and total", () => {
    expect(extractInvoiceText(
      "Due Date: 2026/09/30 Subtotal 1,000",
      "Example",
    )).toMatchObject({
      date: null,
      due_date: "2026-09-30",
      total: null,
      confidence: "low",
    });
  });
});
