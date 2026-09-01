/**
 * 請求書 1 件を Discord webhook 用メッセージへ整形する。
 *
 * 用途は「作成された請求書の中身を人が確認する」こと。 PDF 本体はセッション側の
 * ファイル送信で届くため、 ここでは金額と日付の突き合わせに要る項目だけを出す。
 * 添付は扱わない (webhook は送信専用で、 Qs はファイルを配らない)。
 */

import type { DiscordMessage } from "./discord-notifier.js";
import type { InvoiceRow, InvoiceStatus } from "../db/invoices-repo.js";

export interface BuiltInvoiceNotice {
  message: DiscordMessage;
  /** 内容の同一性判定キー (定期通知の dedup)。 */
  dedupKey: string;
  hasContent: boolean;
}

const COLOR_BY_STATUS: Record<InvoiceStatus, number> = {
  draft: 0x9e9e9e,
  sent: 0x2196f3,
  paid: 0x4caf50,
  overdue: 0xf44336,
  cancelled: 0x616161,
};

const STATUS_JA: Record<InvoiceStatus, string> = {
  draft: "下書き",
  sent: "送付済み",
  paid: "入金済み",
  overdue: "期限超過",
  cancelled: "取消",
};

const yen = (n: number | null | undefined): string => (n == null ? "—" : `¥${n.toLocaleString("ja-JP")}`);
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 請求書 → Discord メッセージ。
 * amount は源泉徴収前の税込総額なので、源泉額が入っているときは差引後の
 * 入金予定額を計算して内訳を併記する。
 * @implements SPEC-INVOICE-NOTICE-003 (spec/feature/invoice-discord-notice.md)
 */
export function buildInvoiceNotice(invoice: InvoiceRow): BuiltInvoiceNotice {
  const invoiceNo = readInvoiceNo(invoice.metadata);
  const netAmount = invoice.amount - invoice.withholding_tax;
  const amountLine = invoice.withholding_tax > 0
    ? `${yen(netAmount)} (税込 ${yen(invoice.amount)} − 源泉 ${yen(invoice.withholding_tax)})`
    : yen(invoice.amount);
  const fields = [
    { name: "請求先", value: truncate(invoice.client, 200), inline: true },
    { name: "状態", value: STATUS_JA[invoice.status] ?? invoice.status, inline: true },
    { name: "請求日", value: invoice.issued_at, inline: true },
    { name: "支払期限", value: invoice.due_date ?? "—", inline: true },
    { name: "請求額", value: amountLine, inline: true },
    { name: "摘要", value: truncate(invoice.work_summary, 1000) },
  ];
  if (invoice.notes) fields.push({ name: "備考", value: truncate(invoice.notes, 500) });

  return {
    message: {
      embeds: [{
        title: invoiceNo == null ? `🧾 請求書 #${invoice.id}` : `🧾 請求書 No.${invoiceNo}`,
        description: "内容を確認してください。 PDF はセッションから別途送られます。",
        color: COLOR_BY_STATUS[invoice.status] ?? 0x2196f3,
        fields,
        footer: { text: `Quaestor invoice id=${invoice.id}` },
      }],
    },
    // status と金額が変われば再通知する (同じ請求書でも状態遷移は知りたい)。
    dedupKey: `invoice:${invoice.id}:${invoice.status}:${invoice.amount}:${invoice.updated_at}`,
    hasContent: true,
  };
}

/** metadata (JSON 文字列) に請求書番号があれば拾う。壊れていても通知は止めない。 */
function readInvoiceNo(metadata: string | null): number | string | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const value = record.invoice_no;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length > 0 && normalized.length <= 40) return normalized;
    }
    return null;
  } catch {
    return null;
  }
}
