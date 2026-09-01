/**
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 */

import type { InvoiceRow } from "../db/invoices-repo.js";
import { INVOICE_AGREEMENT_TEXT } from "./invoice-agreement.js";

const PASSKEY_SCRIPT_PATH = "/v1/invoices/share/passkey.js";

/**
 * 合意 UI の状態。
 * - accepted: 合意済み (記録と証跡リンクを表示)
 * - passkey: 登録済みパスキーで署名できる
 * - enroll: 送信先は登録済みだがパスキー未登録 → メール OTP で本人確認してから登録
 * - unavailable: 送信先台帳に紐づいていないリンク (合意できない)
 */
export type InvoiceShareAcceptanceState = "accepted" | "passkey" | "enroll" | "unavailable";

export function invoiceSharePage(input: {
  token: string;
  invoice: InvoiceRow;
  expiresAt: number;
  documentSha256: string;
  recipientCompany: string | null;
  acceptedAt?: number;
  acceptanceState?: InvoiceShareAcceptanceState;
}): string {
  const documentUrl = `/v1/invoices/share/${encodeURIComponent(input.token)}/document.pdf`;
  const acceptanceUrl = `/v1/invoices/share/${encodeURIComponent(input.token)}/accept`;
  const evidenceUrl = `/v1/invoices/share/${encodeURIComponent(input.token)}/evidence.json`;
  const state: InvoiceShareAcceptanceState = input.acceptedAt !== undefined
    ? "accepted"
    : input.acceptanceState ?? "enroll";
  const expiresAt = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(input.expiresAt * 1000));
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>請求書の確認</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f4f6f8; color: #172033; }
    main { max-width: 640px; margin: 8vh auto; padding: 0 20px; }
    section { background: #fff; border: 1px solid #dbe1e8; border-radius: 14px; padding: 32px; box-shadow: 0 10px 30px rgb(15 23 42 / 8%); }
    h1 { margin: 0 0 24px; font-size: 1.7rem; }
    dl { display: grid; grid-template-columns: 8em 1fr; gap: 12px; margin: 0 0 28px; }
    dt { color: #536175; }
    dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
    a { display: inline-block; border-radius: 9px; padding: 13px 22px; background: #155eef; color: #fff; font-weight: 700; text-decoration: none; }
    form { margin-top: 28px; border-top: 1px solid #dbe1e8; padding-top: 24px; }
    label { display: flex; gap: 10px; align-items: flex-start; line-height: 1.6; }
    input { margin-top: 5px; inline-size: 18px; block-size: 18px; }
    button { margin-top: 16px; border: 0; border-radius: 9px; padding: 13px 22px; background: #087443; color: #fff; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .6; cursor: default; }
    .accepted { margin-top: 28px; border-radius: 9px; padding: 16px; background: #e8f7ef; color: #075d36; font-weight: 700; }
    .accepted a { display: inline; background: none; color: #075d36; padding: 0; text-decoration: underline; font-weight: 600; }
    .passkey { margin-top: 28px; border-top: 1px solid #dbe1e8; padding-top: 24px; }
    .status { margin-top: 12px; border-radius: 8px; padding: 10px 12px; background: #eef3ff; color: #1d3f8f; min-height: 1.2em; font-size: .92rem; }
    .status:empty { display: none; }
    .status.error { background: #fff1f0; color: #9b1c1c; }
    .notice { margin-top: 28px; border-radius: 9px; padding: 16px; background: #fff7e6; color: #7a4b00; }
    .legal { font-size: .82rem; }
    p { margin: 24px 0 0; color: #536175; font-size: .92rem; line-height: 1.6; }
    @media (max-width: 520px) { section { padding: 24px; } dl { grid-template-columns: 1fr; gap: 5px; } dd { margin-bottom: 10px; } }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>請求書の確認</h1>
      <dl>
        <dt>宛先</dt><dd>${escapeHtml(input.recipientCompany ?? input.invoice.client)}</dd>
        <dt>発行日</dt><dd>${escapeHtml(input.invoice.issued_at)}</dd>
        <dt>お支払期限</dt><dd>${escapeHtml(input.invoice.due_date ?? "記載なし")}</dd>
        <dt>請求金額</dt><dd>${escapeHtml(input.invoice.amount.toLocaleString("ja-JP"))}円</dd>
      </dl>
      <a href="${documentUrl}">請求書PDFを表示</a>
      ${acceptanceSection(state, input.acceptedAt, acceptanceUrl, evidenceUrl, input.token)}
      <p>このリンクの有効期限は ${escapeHtml(expiresAt)} です。リンクを第三者へ転送しないでください。</p>
      <p class="legal">文書識別子: ${escapeHtml(input.documentSha256.slice(0, 16))}。合意はお使いの端末のパスキー (公開鍵暗号) による署名で記録され、署名対象には請求書PDFのハッシュが含まれます。認定認証事業者の電子証明書を使う電子署名ではありません。</p>
    </section>
  </main>
  ${state === "passkey" ? `<script src="${PASSKEY_SCRIPT_PATH}" defer></script>` : ""}
</body>
</html>`;
}

function acceptanceSection(
  state: InvoiceShareAcceptanceState,
  acceptedAtEpochSeconds: number | undefined,
  acceptanceUrl: string,
  evidenceUrl: string,
  token: string,
): string {
  if (state === "accepted" && acceptedAtEpochSeconds !== undefined) {
    const acceptedAt = new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Asia/Tokyo",
    }).format(new Date(acceptedAtEpochSeconds * 1000));
    return `<div class="accepted">${escapeHtml(acceptedAt)} に請求内容への合意を記録しました。
        <a href="${evidenceUrl}">署名証跡 (JSON) を取得</a></div>`;
  }
  if (state === "passkey") {
    return `<div class="passkey" data-passkey-root data-mode="accept" data-token="${escapeHtml(token)}">
        <label><input type="checkbox" data-passkey-agree><span>${escapeHtml(INVOICE_AGREEMENT_TEXT)}</span></label>
        <button type="button" data-passkey-button>パスキーで合意に署名する</button>
        <div class="status" data-passkey-status></div>
        <p>登録済みのパスキーで、請求書PDFのハッシュと合意文言を含むステートメントに署名します。署名の控え (証跡JSON) を登録メールアドレスへお送りします。</p>
      </div>`;
  }
  if (state === "unavailable") {
    return `<div class="notice">このリンクは送信先台帳に紐づいていないため、画面上での合意はできません。送信元へご連絡ください。</div>`;
  }
  return `<form method="post" action="${acceptanceUrl}">
        <label><input type="checkbox" name="confirm" value="accepted" required><span>${escapeHtml(INVOICE_AGREEMENT_TEXT)}</span></label>
        <button type="submit">メール確認へ進む (初回のみ)</button>
        <p>初回は登録済みメールアドレスへ確認コードを送り、本人確認のうえ端末にパスキーを登録します。合意はそのパスキーによる署名で確定します。2回目以降はメール確認なしで署名できます。</p>
      </form>`;
}

export function invalidInvoiceSharePage(): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>リンクを確認できません</title></head>
<body><main><h1>リンクを確認できません</h1><p>リンクが無効、期限切れ、または取り消されています。</p></main></body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
