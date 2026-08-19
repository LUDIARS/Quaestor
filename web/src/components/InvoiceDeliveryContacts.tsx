import { useEffect, useState } from "react";
import { InvoiceContactPasskeys } from "./InvoiceContactPasskeys";

interface InvoiceDeliveryContact {
  id: string;
  company_name: string;
  email: string;
  active: 0 | 1;
}

const EMPTY_FORM = { company_name: "", email: "" };

/** サーバのエラーコードは内部語彙なので、そのまま画面へ出さず日本語へ写像する。 */
const ERROR_MESSAGES: Record<string, string> = {
  email_already_registered: "このメールアドレスは登録済みです",
  invalid_request: "企業名とメールアドレスの形式を確認してください",
  not_found: "対象の送信先が見つかりません",
};

/** JSON でない失敗応答でも SyntaxError ではなく意図した日本語文言を投げる。 */
async function contactsApi<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) {
    const code = body?.error;
    throw new Error(
      (code ? ERROR_MESSAGES[code] : undefined) ?? `${fallback} (${response.status})`,
    );
  }
  return (body ?? {}) as T;
}

export function InvoiceDeliveryContacts() {
  const [contacts, setContacts] = useState<InvoiceDeliveryContact[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const body = await contactsApi<{ items?: InvoiceDeliveryContact[] }>(
      "/v1/invoice-delivery-contacts",
      undefined,
      "送信先を取得できませんでした",
    );
    setContacts(body.items ?? []);
  }

  useEffect(() => {
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);

  function beginCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setOpen(true);
  }

  function beginEdit(contact: InvoiceDeliveryContact) {
    setEditingId(contact.id);
    setForm({ company_name: contact.company_name, email: contact.email });
    setError(null);
    setOpen(true);
  }

  function closeForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOpen(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await contactsApi(
        editingId ? `/v1/invoice-delivery-contacts/${editingId}` : "/v1/invoice-delivery-contacts",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(form),
        },
        "送信先を保存できませんでした",
      );
      closeForm();
      await load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(contact: InvoiceDeliveryContact) {
    if (!window.confirm(`${contact.company_name} を送信先一覧から無効化しますか？`)) return;
    setError(null);
    try {
      await contactsApi(
        `/v1/invoice-delivery-contacts/${contact.id}`,
        { method: "DELETE" },
        "送信先を無効化できませんでした",
      );
      if (editingId === contact.id) closeForm();
      await load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section className="last-capture" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
        <div>
          <h3 style={{ margin: 0 }}>請求書の送信先</h3>
          <p style={{ color: "var(--muted)", fontSize: "0.8rem", margin: "0.2rem 0 0" }}>
            マジックリンク送信時に選択する企業名とメールアドレス、 合意署名に使うパスキーを管理します。
          </p>
        </div>
        <button className="btn secondary" type="button" onClick={open ? closeForm : beginCreate}>
          {open ? "閉じる" : "+ 送信先を登録"}
        </button>
      </div>

      {open && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end", marginTop: "0.75rem" }}>
          <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.8rem" }}>
            企業名
            <input
              type="text"
              value={form.company_name}
              onChange={(event) => setForm({ ...form, company_name: event.target.value })}
              placeholder="例: 取引先株式会社"
              maxLength={200}
            />
          </label>
          <label style={{ display: "grid", gap: "0.2rem", fontSize: "0.8rem" }}>
            メールアドレス
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="billing@example.com"
              maxLength={320}
              style={{ minWidth: 240 }}
            />
          </label>
          <button
            className="btn"
            type="button"
            disabled={saving || !form.company_name.trim() || !form.email.trim()}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : editingId ? "変更を保存" : "登録"}
          </button>
        </div>
      )}

      {error && <p className="error" style={{ marginBottom: 0 }}>{error}</p>}

      {contacts.length > 0 ? (
        <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "0.4rem" }}>企業名</th>
                <th style={{ textAlign: "left", padding: "0.4rem" }}>メールアドレス</th>
                <th style={{ textAlign: "left", padding: "0.4rem" }}>パスキー</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "0.4rem" }}>{contact.company_name}</td>
                  <td style={{ padding: "0.4rem" }}>{contact.email}</td>
                  <td style={{ padding: "0.4rem" }}>
                    <InvoiceContactPasskeys contactId={contact.id} companyName={contact.company_name} />
                  </td>
                  <td style={{ padding: "0.4rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn secondary" type="button" onClick={() => beginEdit(contact)}>編集</button>{" "}
                    <button className="btn secondary" type="button" onClick={() => void deactivate(contact)}>無効化</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginBottom: 0 }}>送信先はまだ登録されていません。</p>
      )}
    </section>
  );
}
