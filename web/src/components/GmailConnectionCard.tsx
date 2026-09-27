import { useEffect, useState } from "react";

interface ConnectionStatus { configured: boolean; setupUrl: string }

export function GmailConnectionCard() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState(false);
  async function refresh() {
    try {
      const response = await fetch("/v1/gmail-auth/status", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const value = await response.json() as ConnectionStatus;
      const url = new URL(value.setupUrl);
      const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1");
      if (!allowedProtocol || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/gmail-auth/setup") throw new Error("invalid setup URL");
      setStatus(value); setError(false);
    } catch { setError(true); }
  }
  useEffect(() => { void refresh(); }, []);
  return <div className="border rounded p-4 space-y-3">
    <h2 className="text-base font-semibold">Gmail 連携</h2>
    <p className="text-sm">請求書・領収書メールの読み取りを Google で許可します。トークンは Qs が直接受け取り、暗号化して保存します。</p>
    {status && <p>{status.configured ? "認証情報は保存済みです。" : "Gmail は未連携です。"}</p>}
    <p className="text-sm text-subtle">このブラウザから Google で認証できます。GCP の既存ウェブアプリ用 OAuth クライアント情報を使い、認証画面に表示されるリダイレクト URI を登録してください。リアルタイム受信の設定は別途必要です。</p>
    {status && <a className="inline-block border rounded px-3 py-2" href={status.setupUrl} target="_blank" rel="noreferrer">{status.configured ? "Gmail を再認証" : "Gmail と連携"}</a>}
    <button type="button" className="border rounded px-3 py-2 ml-2" onClick={() => void refresh()}>保存状態を確認</button>
    {error && <p role="alert">接続状態を取得できません。Qs へのログイン状態と接続を確認してください。</p>}
  </div>;
}
