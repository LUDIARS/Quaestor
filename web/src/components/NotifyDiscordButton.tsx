import { useState } from "react";

interface NotifyResult { sent?: boolean; skipped?: boolean; disabled?: boolean; reason?: string }

/** アドバイザーのアドバイスを Discord に通知するボタン (オンデマンド送信) */
export function NotifyDiscordButton({ endpoint, body, label }: { endpoint: string; body?: object; label?: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setStatus(null);
    try {
      const r = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
      }).then((res) => res.json() as Promise<NotifyResult>);
      setStatus(
        r.disabled ? "⚠ webhook 未設定"
          : r.sent ? "✓ Discord に送信"
          : r.skipped ? (r.reason ?? "送信対象なし")
          : (r.reason ?? "送信失敗"),
      );
    } catch (e: unknown) { setStatus(e instanceof Error ? e.message : "エラー"); }
    setBusy(false);
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
      <button className="btn" onClick={() => void run()} disabled={busy}>
        {busy ? "送信中…" : (label ?? "Discordに通知")}
      </button>
      {status && <small style={{ color: "var(--muted)" }}>{status}</small>}
    </span>
  );
}
