import { useEffect, useState } from "react";

interface TxRow {
  id: string;
  date: string;
  amount_in: number | null;
  amount_out: number | null;
  currency: string;
  fx_amount: number | null;
  fx_currency: string | null;
  description: string;
  payee: string | null;
  source: string;
  account: string | null;
}

interface ListRes {
  items: TxRow[];
  total: number;
  limit: number;
  offset: number;
}

export function Transactions() {
  const [data, setData] = useState<ListRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [payee, setPayee] = useState("");
  const [source, setSource] = useState("");

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("date_from", from);
      if (to) params.set("date_to", to);
      if (payee) params.set("payee_like", payee);
      if (source) params.set("source", source);
      params.set("limit", "200");
      const j = await (await fetch(`/v1/transactions?${params}`)).json() as ListRes;
      setData(j);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div>
      <h2>Transactions</h2>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem", fontSize: "0.85rem" }}>
        <label>from <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>payee <input type="text" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="部分一致" /></label>
        <label>
          source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">(any)</option>
            <option>credit-card</option>
            <option>bank</option>
            <option>amazon</option>
            <option>receipt</option>
            <option>manual</option>
          </select>
        </label>
        <button className="btn secondary" onClick={() => void load()}>絞込</button>
      </div>

      {loading && <p>loading…</p>}
      {err && <p className="error">{err}</p>}
      {data && (
        <>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            total: {data.total.toLocaleString()} ｜ shown: {data.items.length}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "0.4rem" }}>date</th>
                <th style={{ textAlign: "left", padding: "0.4rem" }}>payee</th>
                <th style={{ textAlign: "right", padding: "0.4rem" }}>out</th>
                <th style={{ textAlign: "right", padding: "0.4rem" }}>in</th>
                <th style={{ textAlign: "left", padding: "0.4rem" }}>account</th>
                <th style={{ textAlign: "left", padding: "0.4rem" }}>source</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "0.4rem" }}>{t.date}</td>
                  <td style={{ padding: "0.4rem" }}>{t.payee ?? t.description}</td>
                  <td style={{ padding: "0.4rem", textAlign: "right", color: t.amount_out ? "var(--danger)" : "var(--muted)" }}>
                    {t.amount_out != null ? `¥${t.amount_out.toLocaleString()}` : ""}
                    {t.fx_amount && t.fx_currency ? <span style={{ color: "var(--muted)", marginLeft: 4 }}>({t.fx_amount} {t.fx_currency})</span> : null}
                  </td>
                  <td style={{ padding: "0.4rem", textAlign: "right", color: t.amount_in ? "var(--ok)" : "var(--muted)" }}>
                    {t.amount_in != null ? `¥${t.amount_in.toLocaleString()}` : ""}
                  </td>
                  <td style={{ padding: "0.4rem", color: "var(--muted)" }}>{t.account ?? "-"}</td>
                  <td style={{ padding: "0.4rem", color: "var(--muted)" }}>{t.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
