import { useState } from "react";

export interface ReceiptItem {
  name: string;
  price: number;
  qty?: number;
}

export interface EditableReceipt {
  id: string;
  ocr_status: string;
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;     // JSON
}

interface Props {
  receipt: EditableReceipt;
  onSaved?: () => void;
  onClose?: () => void;
}

export function ReceiptEditor({ receipt, onSaved, onClose }: Props) {
  const [date, setDate] = useState(receipt.date ?? "");
  const [payee, setPayee] = useState(receipt.payee ?? "");
  const [total, setTotal] = useState<string>(receipt.total != null ? String(receipt.total) : "");
  const initialItems: ReceiptItem[] = receipt.items
    ? (() => {
        try { return JSON.parse(receipt.items) as ReceiptItem[]; } catch { return []; }
      })()
    : [];
  const [items, setItems] = useState<ReceiptItem[]>(initialItems);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function updateItem(i: number, patch: Partial<ReceiptItem>) {
    setItems((arr) => arr.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  }
  function removeItem(i: number) {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }
  function addItem() {
    setItems((arr) => [...arr, { name: "", price: 0, qty: 1 }]);
  }

  async function save(status: "manual" | "done" = "manual") {
    setSaving(true);
    setErr(null);
    try {
      const body = {
        ocr_status: status,
        date: date || null,
        payee: payee || null,
        total: total ? parseInt(total, 10) : null,
        items: items.length > 0 ? items : null,
      };
      const res = await fetch(`/v1/receipts/${receipt.id}/ocr`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `${res.status}`);
      }
      onSaved?.();
      onClose?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const itemsTotal = items.reduce((s, it) => s + (it.price ?? 0) * (it.qty ?? 1), 0);

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "1rem", marginTop: "0.5rem" }}>
      <div style={{ display: "grid", gap: "0.5rem", maxWidth: 640 }}>
        <label>
          日付: <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          店名: <input type="text" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="例: サイゼリヤ 中目黒店" style={{ width: 300 }} />
        </label>
        <label>
          合計 (円): <input type="number" value={total} onChange={(e) => setTotal(e.target.value)} style={{ width: 120 }} />
          {items.length > 0 && (
            <span style={{ marginLeft: "0.5rem", color: itemsTotal === parseInt(total || "0", 10) ? "var(--ok)" : "var(--danger)", fontSize: "0.8rem" }}>
              ({items.length} item の和: ¥{itemsTotal.toLocaleString()})
            </span>
          )}
        </label>
      </div>

      <h4 style={{ fontSize: "0.9rem", marginTop: "1rem", marginBottom: "0.4rem" }}>明細 ({items.length})</h4>
      <table style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th style={{ textAlign: "left", padding: "0.2rem" }}>商品名</th>
            <th style={{ textAlign: "right", padding: "0.2rem" }}>単価</th>
            <th style={{ textAlign: "right", padding: "0.2rem" }}>個数</th>
            <th style={{ textAlign: "right", padding: "0.2rem" }}>小計</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i} style={{ borderBottom: "1px dotted var(--border)" }}>
              <td style={{ padding: "0.2rem" }}>
                <input type="text" value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} style={{ width: "100%" }} />
              </td>
              <td style={{ padding: "0.2rem", textAlign: "right" }}>
                <input type="number" value={it.price} onChange={(e) => updateItem(i, { price: parseInt(e.target.value) || 0 })} style={{ width: 80, textAlign: "right" }} />
              </td>
              <td style={{ padding: "0.2rem", textAlign: "right" }}>
                <input type="number" value={it.qty ?? 1} onChange={(e) => updateItem(i, { qty: parseInt(e.target.value) || 1 })} style={{ width: 50, textAlign: "right" }} />
              </td>
              <td style={{ padding: "0.2rem", textAlign: "right", color: "var(--muted)" }}>
                ¥{((it.price ?? 0) * (it.qty ?? 1)).toLocaleString()}
              </td>
              <td>
                <button className="btn secondary" onClick={() => removeItem(i)} style={{ padding: "0.1rem 0.4rem", fontSize: "0.75rem" }}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn secondary" onClick={addItem} style={{ marginTop: "0.5rem", padding: "0.2rem 0.5rem", fontSize: "0.8rem" }}>+ 明細</button>

      <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button className="btn" onClick={() => void save("manual")} disabled={saving}>
          {saving ? "saving…" : "保存 (manual)"}
        </button>
        <button className="btn secondary" onClick={() => void save("done")} disabled={saving}>
          確定 (done)
        </button>
        {onClose && <button className="btn secondary" onClick={onClose}>cancel</button>}
        {err && <span className="error" style={{ marginLeft: "0.5rem" }}>{err}</span>}
      </div>
    </div>
  );
}
