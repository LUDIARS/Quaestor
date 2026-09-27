import type { GmailAuthStatus } from "./gmail-oauth.js";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? "");
}

/** Script-free, backend-hosted form: secrets are submitted directly from the user's browser. */
export function gmailOAuthPage(status: GmailAuthStatus, csrf: string, result?: string): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gmail 連携 — Quaestor</title><style>
:root{font-family:system-ui,sans-serif;color:#e9edf5;background:#111827;color-scheme:dark}body{margin:0;padding:24px}main{max-width:700px;margin:30px auto;line-height:1.7}h1{font-size:1.6rem}fieldset{border:1px solid #4b5563;border-radius:12px;padding:18px}input{box-sizing:border-box;display:block;width:100%;padding:10px;border:1px solid #6b7280;border-radius:6px;margin-top:6px}button{font:inherit;background:#2563eb;color:white;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}code{overflow-wrap:anywhere}a{color:#93c5fd}[role=status]{background:#064e3b;padding:12px;border-radius:8px}[role=alert]{background:#7f1d1d;padding:12px;border-radius:8px}
</style><body><main>
<h1>Gmail と連携</h1>
<p>${status.configured ? "認証情報は保存済みです。再認証する場合は同じ Google アカウントを選んでください。" : "Google でアクセスを許可すると、Qs が認証情報を直接受け取り暗号化して保存します。"}</p>
${result === "saved" ? "<p role=\"status\">保存しました。メールの定期取得に反映されます。リアルタイム受信は別途設定が必要です。</p>" : ""}
${result === "failed" ? "<p role=\"alert\">認証を完了できませんでした。Google で読み取りを許可し、クライアントとリダイレクト URI を確認してやり直してください。既存の保存内容は変更していません。</p>" : ""}
<p>GCP の「Google Auth Platform → クライアント」で既存の OAuth クライアントを確認してください。
公開ドメインで認証する場合はウェブアプリ用クライアントを使い、次の URI を「承認済みのリダイレクト URI」に登録します。</p>
<p><code>${escape(status.redirectUri)}</code></p>
<form action="/v1/gmail-auth/start" method="post" enctype="multipart/form-data" autocomplete="off">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<fieldset><legend>GCP のクライアント情報</legend>
<p>ダウンロード済みの OAuth クライアント JSON を選択するか、ID とシークレットを入力してください。サービスアカウント鍵は使えません。</p>
<p><label>OAuth クライアント JSON <input name="client_file" type="file" accept=".json,application/json"></label></p>
<p><label>クライアント ID <input name="client_id" type="text" maxlength="256" autocomplete="off"></label></p>
<p><label>クライアントシークレット <input name="client_secret" type="password" maxlength="4096" autocomplete="new-password"></label></p>
${status.clientConfigured ? "<p>登録済みのクライアントを使う場合は、ファイル・入力欄を空のまま進めます。</p>" : ""}
</fieldset><p><button type="submit">Google で読み取りを許可する</button></p></form>
<p>トークンのコピーやチャットへの貼り付けは不要です。認証画面は10分で期限切れになります。その場合はこのページを再読み込みしてください。</p>
</main></body></html>`;
}
