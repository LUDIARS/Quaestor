/**
 * 請求書 `:id` パスパラメータの解釈。 10 進の正整数だけを受け、 `Number.parseInt` の前方一致 ("12abc" → 12) を避ける。
 * 発行者側 (/v1/invoices/:id) と公開リンク側 (/v1/invoices/:id/share) で共用する。
 *
 * @implements SPEC-INVOICE-DELIVERY-003 (spec/feature/invoice-public-magic-link.md)
 */
export function invoiceIdOf(raw: string): number | null {
  if (!/^[0-9]{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
