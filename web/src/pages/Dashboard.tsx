import { useEffect, useState } from "react";

interface Monthly { month: string; amount_in: number; amount_out: number; count: number }
interface BySource { source: string; amount_in: number; amount_out: number; count: number }
interface TopPayee { payee: string; total_out: number; count: number }
interface DashboardRes {
  range: { from: string; to: string };
  grand_total: { amount_in: number; amount_out: number; count: number };
  monthly: Monthly[];
  by_source: BySource[];
  top_payees: TopPayee[];
}

export function Dashboard() {
  const [data, setData] = useState<DashboardRes | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("top_payees", "10");
      const j = await (await fetch(`/v1/dashboard/summary?${params}`)).json() as DashboardRes;
      setData(j);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading) return <p>loading…</p>;
  if (err) return <p className="error">{err}</p>;
  if (!data) return null;

  const maxBar = Math.max(
    ...data.monthly.map((m) => Math.max(m.amount_in, m.amount_out)),
    1,
  );

  return (
    <div>
      <h2>Dashboard</h2>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem", fontSize: "0.85rem" }}>
        <label>from <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={data.range.from} /></label>
        <label>to <input type="month" value={to} onChange={(e) => setTo(e.target.value)} placeholder={data.range.to} /></label>
        <button className="btn secondary" onClick={() => void load()}>更新</button>
        <span style={{ color: "var(--muted)", marginLeft: "0.5rem" }}>{data.range.from} 〜 {data.range.to}</span>
      </div>

      <section className="last-capture" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>期間合計</h3>
        <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.95rem" }}>
          <div>取引数 <strong>{data.grand_total.count.toLocaleString()}</strong></div>
          <div>入金 <strong style={{ color: "var(--ok)" }}>¥{data.grand_total.amount_in.toLocaleString()}</strong></div>
          <div>出金 <strong style={{ color: "var(--danger)" }}>¥{data.grand_total.amount_out.toLocaleString()}</strong></div>
          <div>差引 <strong>¥{(data.grand_total.amount_in - data.grand_total.amount_out).toLocaleString()}</strong></div>
        </div>
      </section>

      <section className="last-capture" style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>月別</h3>
        <div style={{ display: "grid", gap: "0.4rem" }}>
          {data.monthly.map((m) => (
            <div key={m.month} style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr 100px", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
              <span style={{ color: "var(--muted)" }}>{m.month}</span>
              <div style={{ background: "var(--bg)", borderRadius: 3, position: "relative", height: 16 }}>
                <div style={{ width: `${(m.amount_in / maxBar) * 100}%`, background: "var(--ok)", height: "100%", borderRadius: 3 }} />
                <span style={{ position: "absolute", inset: 0, padding: "0 0.4rem", fontSize: "0.7rem", color: "white", display: "flex", alignItems: "center" }}>
                  in ¥{m.amount_in.toLocaleString()}
                </span>
              </div>
              <div style={{ background: "var(--bg)", borderRadius: 3, position: "relative", height: 16 }}>
                <div style={{ width: `${(m.amount_out / maxBar) * 100}%`, background: "var(--danger)", height: "100%", borderRadius: 3 }} />
                <span style={{ position: "absolute", inset: 0, padding: "0 0.4rem", fontSize: "0.7rem", color: "white", display: "flex", alignItems: "center" }}>
                  out ¥{m.amount_out.toLocaleString()}
                </span>
              </div>
              <span style={{ textAlign: "right", color: m.amount_in - m.amount_out >= 0 ? "var(--ok)" : "var(--danger)" }}>
                {m.amount_in - m.amount_out >= 0 ? "+" : ""}¥{(m.amount_in - m.amount_out).toLocaleString()}
              </span>
            </div>
          ))}
          {data.monthly.length === 0 && <span style={{ color: "var(--muted)" }}>該当データなし</span>}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        <section className="last-capture">
          <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>source 別</h3>
          <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "0.3rem" }}>source</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>件</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>in</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>out</th>
              </tr>
            </thead>
            <tbody>
              {data.by_source.map((s) => (
                <tr key={s.source} style={{ borderBottom: "1px dotted var(--border)" }}>
                  <td style={{ padding: "0.3rem" }}>{s.source}</td>
                  <td style={{ padding: "0.3rem", textAlign: "right" }}>{s.count}</td>
                  <td style={{ padding: "0.3rem", textAlign: "right", color: "var(--ok)" }}>¥{s.amount_in.toLocaleString()}</td>
                  <td style={{ padding: "0.3rem", textAlign: "right", color: "var(--danger)" }}>¥{s.amount_out.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="last-capture">
          <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>支出 Top 10</h3>
          <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "0.3rem" }}>payee</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>件</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>total</th>
              </tr>
            </thead>
            <tbody>
              {data.top_payees.map((p) => (
                <tr key={p.payee} style={{ borderBottom: "1px dotted var(--border)" }}>
                  <td style={{ padding: "0.3rem", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{p.payee}</td>
                  <td style={{ padding: "0.3rem", textAlign: "right" }}>{p.count}</td>
                  <td style={{ padding: "0.3rem", textAlign: "right", color: "var(--danger)" }}>¥{p.total_out.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
