import { useEffect, useState } from "react";
import { ReceiptEditor } from "../components/ReceiptEditor.js";

interface ReceiptRow {
  id: string;
  captured_at: number;
  image_path: string | null;
  ocr_status: string;
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;
}

export function Receipts() {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [list, health] = await Promise.all([
        fetch("/v1/receipts?limit=50").then((r) => r.json() as Promise<{ items: ReceiptRow[] }>),
        fetch("/health").then((r) => r.json() as Promise<{ ocr_enabled?: boolean }>),
      ]);
      setRows(list.items);
      setOcrEnabled(!!health.ocr_enabled);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function runOcr(id: string) {
    setRunning(id);
    try {
      const res = await fetch(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(j.message ?? j.error ?? `${res.status}`);
      }
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  if (loading) return <p>loading…</p>;
  if (err) return <p className="error">{err} <button className="btn secondary" onClick={() => { setErr(null); void load(); }}>retry</button></p>;
  if (rows.length === 0) return <p>まだレシートが無い。 scan ページから取り込んで。</p>;

  return (
    <div>
      <h2>Receipts ({rows.length}) {ocrEnabled ? <small style={{ color: "var(--ok)" }}>OCR enabled</small> : <small style={{ color: "var(--muted)" }}>OCR disabled (ANTHROPIC_API_KEY 未設定)</small>}</h2>
      <ul style={{ display: "grid", gap: "0.5rem", listStyle: "none", padding: 0 }}>
        {rows.map((r) => (
          <li key={r.id} className="last-capture">
            <code>{r.id.slice(0, 8)}…</code> ｜ status: <strong>{r.ocr_status}</strong> ｜
            captured: {new Date(r.captured_at * 1000).toLocaleString()}
            {r.payee ? <> ｜ payee: {r.payee}</> : null}
            {r.total != null ? <> ｜ total: ¥{r.total.toLocaleString()}</> : null}
            {ocrEnabled && (r.ocr_status === "pending" || r.ocr_status === "failed") && (
              <>
                {" "}<button
                  className="btn secondary"
                  disabled={running === r.id}
                  onClick={() => void runOcr(r.id)}
                  style={{ marginLeft: "0.5rem", padding: "0.25rem 0.5rem", fontSize: "0.8rem" }}
                >
                  {running === r.id ? "running…" : "OCR"}
                </button>
              </>
            )}
            <button
              className="btn secondary"
              onClick={() => setEditing(editing === r.id ? null : r.id)}
              style={{ marginLeft: "0.5rem", padding: "0.25rem 0.5rem", fontSize: "0.8rem" }}
            >
              {editing === r.id ? "閉じる" : "編集"}
            </button>
            {editing === r.id && (
              <ReceiptEditor
                receipt={r}
                onSaved={() => void load()}
                onClose={() => setEditing(null)}
              />
            )}
            {r.image_path ? (
              <>
                <br />
                <img src={`/v1/receipts/${r.id}/image`} alt="receipt" />
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
