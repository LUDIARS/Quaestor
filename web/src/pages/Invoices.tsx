import { useEffect, useState } from "react";
import { YearTabs, currentYear } from "../components/YearTabs.js";

interface InvoiceRow {
  id: number;
  issued_at: string;
  due_date: string | null;
  client: string;
  work_summary: string;
  amount: number;
  withholding_tax: number;
  status: string;
  transaction_id: string | null;
  notes: string | null;
}

interface SummaryRow { count: number; amount: number; withholding: number }
interface SummaryRes {
  summary: Record<string, SummaryRow>;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  sent: "発行済",
  paid: "入金済",
  overdue: "未収",
  cancelled: "取消",
};

export function Invoices() {
  const [list, setList] = useState<InvoiceRow[]>([]);
  const [summary, setSummary] = useState<SummaryRes["summary"] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [year, setYear] = useState(currentYear());
  const [form, setForm] = useState({
    issued_at: new Date().toISOString().slice(0, 10),
    due_date: "",
    client: "",
    work_summary: "",
    amount: "",
    withholding_tax: "0",
    notes: "",
  });

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (year !== "all") {
        params.set("date_from", `${year}-01-01`);
        params.set("date_to", `${year}-12-31`);
      }
      const [listJ, sumJ] = await Promise.all([
        fetch(`/v1/invoices?${params}`).then((r) => r.json() as Promise<{ items: InvoiceRow[] }>),
        fetch("/v1/invoices/summary").then((r) => r.json() as Promise<SummaryRes>),
      ]);
      setList(listJ.items);
      setSummary(sumJ.summary);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [year]);

  async function create() {
    setErr(null);
    try {
      const body = {
        issued_at: form.issued_at,
        due_date: form.due_date || null,
        client: form.client,
        work_summary: form.work_summary,
        amount: parseInt(form.amount || "0", 10),
        withholding_tax: parseInt(form.withholding_tax || "0", 10),
        notes: form.notes || null,
        status: "sent",
      };
      const res = await fetch("/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setCreating(false);
      setForm({ ...form, client: "", work_summary: "", amount: "", notes: "" });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function setStatus(id: number, status: string) {
    await fetch(`/v1/invoices/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await load();
  }

  if (loading) return <p>loading…</p>;
  return (
    <div>
      <h2>Invoices (請求書)</h2>

      <YearTabs value={year} onChange={(y) => setYear(y)} />

      {summary && (
        <section style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem", fontSize: "0.85rem" }}>
          {Object.entries(summary).map(([k, v]) => (
            <div key={k} className="last-capture" style={{ padding: "0.5rem 0.75rem", minWidth: 130 }}>
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>{STATUS_LABEL[k] ?? k}</div>
              <div style={{ fontFamily: "monospace" }}>
                {v.count} 件 / ¥{v.amount.toLocaleString()}
                {v.withholding > 0 && <span style={{ color: "var(--muted)", marginLeft: 4 }}>(源泉 ¥{v.withholding.toLocaleString()})</span>}
              </div>
            </div>
          ))}
        </section>
      )}

      <button className="btn" onClick={() => setCreating((v) => !v)} style={{ marginBottom: "0.75rem" }}>
        {creating ? "閉じる" : "+ 新規発行"}
      </button>
      {creating && (
        <section className="last-capture" style={{ marginBottom: "1rem" }}>
          <div style={{ display: "grid", gap: "0.4rem", maxWidth: 520, fontSize: "0.85rem" }}>
            <label>発行日 <input type="date" value={form.issued_at} onChange={(e) => setForm({ ...form, issued_at: e.target.value })} /></label>
            <label>支払期日 <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
            <label>取引先 <input type="text" value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} placeholder="例: 教育機関株式会社" /></label>
            <label>業務内容 <textarea value={form.work_summary} onChange={(e) => setForm({ ...form, work_summary: e.target.value })} rows={3} /></label>
            <label>請求額 (税込) <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} style={{ width: 140 }} /></label>
            <label>源泉徴収額 <input type="number" value={form.withholding_tax} onChange={(e) => setForm({ ...form, withholding_tax: e.target.value })} style={{ width: 140 }} /></label>
            <label>memo <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
            <button className="btn" onClick={() => void create()}>発行</button>
          </div>
        </section>
      )}

      {err && <p className="error">{err}</p>}

      <table style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>発行日</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>取引先</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>業務</th>
            <th style={{ textAlign: "right", padding: "0.4rem" }}>金額</th>
            <th style={{ textAlign: "right", padding: "0.4rem" }}>源泉</th>
            <th style={{ textAlign: "right", padding: "0.4rem" }}>受取</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>状態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((iv) => (
            <tr key={iv.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "0.4rem" }}>{iv.issued_at}</td>
              <td style={{ padding: "0.4rem" }}>{iv.client}</td>
              <td style={{ padding: "0.4rem", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{iv.work_summary}</td>
              <td style={{ padding: "0.4rem", textAlign: "right" }}>¥{iv.amount.toLocaleString()}</td>
              <td style={{ padding: "0.4rem", textAlign: "right", color: "var(--muted)" }}>{iv.withholding_tax > 0 ? `¥${iv.withholding_tax.toLocaleString()}` : "-"}</td>
              <td style={{ padding: "0.4rem", textAlign: "right", color: iv.status === "paid" ? "var(--ok)" : "var(--muted)" }}>
                ¥{(iv.amount - iv.withholding_tax).toLocaleString()}
              </td>
              <td style={{ padding: "0.4rem" }}>
                <select value={iv.status} onChange={(e) => void setStatus(iv.id, e.target.value)}>
                  {Object.keys(STATUS_LABEL).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </td>
              <td>
                {iv.transaction_id ? <code style={{ fontSize: "0.7rem", color: "var(--muted)" }}>tx {iv.transaction_id.slice(0, 6)}</code> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p style={{ color: "var(--muted)", marginTop: "0.5rem" }}>まだ無し</p>}
    </div>
  );
}
