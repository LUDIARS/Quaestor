/**
 * 受領者メール C&R の確認コード入力ページ (パスキー初回登録の本人確認)。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-001 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-003 (spec/feature/invoice-public-magic-link.md)
 */

import { escapeHtml } from "./invoice-share-page.js";

function pageShell(body: string, title = "合意確認"): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:0;background:#f4f6f8;color:#172033}
main{max-width:560px;margin:8vh auto;padding:0 20px}section{background:#fff;border:1px solid #dbe1e8;border-radius:14px;padding:32px}
label{display:block;margin-top:24px;font-weight:700}input{box-sizing:border-box;width:100%;margin-top:8px;padding:13px;font-size:1.3rem;letter-spacing:.25em}
button{margin-top:20px;border:0;border-radius:9px;padding:13px 22px;background:#087443;color:#fff;font-weight:700;cursor:pointer}
.error{border-radius:8px;padding:12px;background:#fff1f0;color:#9b1c1c}p{line-height:1.7;color:#536175}
</style></head><body><main><section>${body}</section></main></body></html>`;
}

export function invoiceShareChallengePage(input: {
  token: string;
  challengeId: string;
  maskedEmail: string;
  expiresAt?: number;
  error?: string;
}): string {
  // Cloudflare Tunnel only needs to expose the stable /accept path.  Keeping the
  // second phase on a child route caused production 404s when ingress lagged the
  // application route, even though the first phase and OTP delivery succeeded.
  const action = `/v1/invoices/share/${encodeURIComponent(input.token)}/accept`;
  const expiresAt = input.expiresAt === undefined ? null : new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "long", timeStyle: "short", timeZone: "Asia/Tokyo",
  }).format(new Date(input.expiresAt * 1000));
  return pageShell(`<h1>メールで本人確認</h1>
    ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
    <p>${escapeHtml(input.maskedEmail)} に6桁の確認コードを送りました。</p>
    <form method="post" action="${action}">
      <input type="hidden" name="challenge_id" value="${escapeHtml(input.challengeId)}">
      <label>確認コード<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
      <button type="submit">コードを確認してパスキー登録へ進む</button>
    </form>${expiresAt ? `<p>有効期限: ${escapeHtml(expiresAt)}。入力は5回までです。</p>` : ""}`);
}

export function invoiceShareChallengeUnavailablePage(): string {
  return pageShell("<h1>確認コードを送信できませんでした</h1><p>時間をおいて再度お試しいただくか、送信元へご連絡ください。</p>");
}
