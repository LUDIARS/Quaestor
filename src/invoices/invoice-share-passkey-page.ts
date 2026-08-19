/**
 * OTP 通過後のパスキー登録 → 署名ページ。 スクリプトは `/share/assets/passkey.js` を読み込む。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 */

import { INVOICE_AGREEMENT_TEXT } from "./invoice-agreement.js";
import { escapeHtml } from "./invoice-share-page.js";

export const PASSKEY_SCRIPT_PATH = "/v1/invoices/share/assets/passkey.js";

export function invoiceSharePasskeyEnrollPage(input: {
  token: string;
  grantId: string;
  recipientCompany: string | null;
  expiresAt: number;
}): string {
  const expiresAt = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "long", timeStyle: "short", timeZone: "Asia/Tokyo",
  }).format(new Date(input.expiresAt * 1000));
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>パスキーの登録と合意</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:0;background:#f4f6f8;color:#172033}
main{max-width:560px;margin:8vh auto;padding:0 20px}section{background:#fff;border:1px solid #dbe1e8;border-radius:14px;padding:32px}
label{display:flex;gap:10px;align-items:flex-start;line-height:1.6;margin-top:24px}input[type=checkbox]{margin-top:5px;inline-size:18px;block-size:18px}
button{margin-top:20px;border:0;border-radius:9px;padding:13px 22px;background:#087443;color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:default}
.status{margin-top:16px;border-radius:8px;padding:12px;background:#eef3ff;color:#1d3f8f;min-height:1.2em}.status.error{background:#fff1f0;color:#9b1c1c}
p{line-height:1.7;color:#536175}ol{line-height:1.8;color:#536175}
</style></head><body><main><section data-passkey-root data-mode="enroll"
  data-token="${escapeHtml(input.token)}" data-grant="${escapeHtml(input.grantId)}">
<h1>本人確認が完了しました</h1>
<p>${escapeHtml(input.recipientCompany ?? "ご担当者")} 様の端末にパスキー (公開鍵) を登録し、その鍵で請求内容への合意に署名します。
秘密鍵はお使いの端末から出ません。次回以降の請求はメール確認なしでこのパスキーだけで合意できます。</p>
<ol><li>ボタンを押すと端末の認証 (Windows Hello / Touch ID / 画面ロック等) が求められます</li>
<li>続けて、請求書 PDF のハッシュと合意文言を含むステートメントに署名します</li>
<li>署名の控え (証跡 JSON) を登録メールアドレスへお送りします</li></ol>
<label><input type="checkbox" data-passkey-agree><span>${escapeHtml(INVOICE_AGREEMENT_TEXT)}</span></label>
<button type="button" data-passkey-button>パスキーを登録して合意に署名する</button>
<div class="status" data-passkey-status></div>
<p>この登録許可の有効期限: ${escapeHtml(expiresAt)}。期限が切れた場合は請求書ページからやり直してください。</p>
</section></main><script src="${PASSKEY_SCRIPT_PATH}" defer></script></body></html>`;
}
