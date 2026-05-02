import { useEffect, useState } from "react";

interface ReceiptRow {
  id: string;
  captured_at: number;
  image_path: string | null;
  ocr_status: string;
  date: string | null;
  payee: string | null;
  total: number | null;
}

export function Receipts() {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    fetch("/v1/receipts?limit=50")
      .then((r) => r.json() as Promise<{ items: ReceiptRow[] }>)
      .then((j) => { if (!cancel) { setRows(j.items); setLoading(false); } })
      .catch((e: unknown) => { if (!cancel) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancel = true; };
  }, []);

  if (loading) return <p>loading…</p>;
  if (err) return <p className="error">{err}</p>;
  if (rows.length === 0) return <p>まだレシートが無い。 scan ページから取り込んで。</p>;

  return (
    <div>
      <h2>Receipts ({rows.length})</h2>
      <ul style={{ display: "grid", gap: "0.5rem", listStyle: "none", padding: 0 }}>
        {rows.map((r) => (
          <li key={r.id} className="last-capture">
            <code>{r.id.slice(0, 8)}…</code> ｜ status: <strong>{r.ocr_status}</strong> ｜
            captured: {new Date(r.captured_at * 1000).toLocaleString()}
            {r.payee ? <> ｜ payee: {r.payee}</> : null}
            {r.total != null ? <> ｜ total: ¥{r.total.toLocaleString()}</> : null}
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
