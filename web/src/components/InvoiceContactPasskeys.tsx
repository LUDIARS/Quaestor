/**
 * 送信先に登録されたパスキーの一覧・失効 UI。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 */
import { useCallback, useEffect, useState } from "react";

/** 送信先に登録されたパスキー (公開鍵) の要約。 公開鍵本体は API が返さない。 */
interface ContactPasskey {
  id: string;
  public_key_sha256: string;
  algorithm: number;
  enrolled_via: "email_otp" | "contract_fingerprint";
  created_at: number;
  revoked_at: number | null;
}

const ENROLLED_VIA_LABEL: Record<ContactPasskey["enrolled_via"], string> = {
  email_otp: "メール確認",
  contract_fingerprint: "契約書記載",
};

function formatDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeZone: "Asia/Tokyo" }).format(new Date(epochSeconds * 1000));
}

/**
 * 送信先 1 件ぶんのパスキー一覧と失効ボタン。 失効は取り消せず、 次回の合意は再びメール確認からになる。
 */
export function InvoiceContactPasskeys({ contactId, companyName }: { contactId: string; companyName: string }) {
  const [items, setItems] = useState<ContactPasskey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/v1/invoice-delivery-contacts/${contactId}/passkeys`);
    const body = await response.json().catch(() => null) as { items?: ContactPasskey[] } | null;
    if (!response.ok) throw new Error(`パスキーを取得できませんでした (${response.status})`);
    setItems(body?.items ?? []);
  }, [contactId]);

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [load]);

  async function revoke(passkey: ContactPasskey) {
    const fingerprint = passkey.public_key_sha256.slice(0, 12);
    if (!window.confirm(`${companyName} のパスキー ${fingerprint}… を失効しますか？\n失効後、次回の合意はメール確認からやり直しになります。`)) return;
    setError(null);
    const response = await fetch(`/v1/invoice-delivery-contacts/${contactId}/passkeys/${passkey.id}/revoke`, { method: "POST" });
    if (!response.ok) {
      setError(`パスキーを失効できませんでした (${response.status})`);
      return;
    }
    await load();
  }

  if (error) return <span className="error" style={{ fontSize: "0.8rem" }}>{error}</span>;
  if (items === null) return <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>…</span>;
  const active = items.filter((item) => item.revoked_at === null);
  if (active.length === 0) {
    return <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>未登録 (初回はメール確認)</span>;
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.2rem" }}>
      {active.map((item) => (
        <li key={item.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
          <code title={item.public_key_sha256}>{item.public_key_sha256.slice(0, 12)}…</code>
          <span style={{ color: "var(--muted)" }}>
            {ENROLLED_VIA_LABEL[item.enrolled_via]} / {formatDate(item.created_at)}
          </span>
          <button className="btn secondary" type="button" onClick={() => void revoke(item)}>失効</button>
        </li>
      ))}
    </ul>
  );
}
