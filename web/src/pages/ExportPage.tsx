import { useState } from "react";
import { YearTabs, currentYear } from "../components/YearTabs.js";

interface JournalEntry {
  no: number;
  date: string;
  debit_code: number;
  debit_name: string;
  debit_amount: number;
  credit_code: number;
  credit_name: string;
  credit_amount: number;
  description: string;
  payment: number;
  rate: number;
}

export function ExportPage() {
  const [year, setYear] = useState(currentYear());
  const [from, setFrom] = useState(`${currentYear()}-01-01`);
  const [to, setTo] = useState(`${currentYear()}-12-31`);
  const [startNo, setStartNo] = useState(1);
  const [preview, setPreview] = useState<JournalEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function buildQuery(): string {
    const params = new URLSearchParams();
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    if (startNo > 1) params.set("start_no", String(startNo));
    return params.toString();
  }

  async function loadPreview() {
    setLoading(true);
    setErr(null);
    try {
      const j = await (await fetch(`/v1/exports/journal/preview?${buildQuery()}`)).json() as { entries: JournalEntry[]; count: number };
      setPreview(j.entries);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function downloadXlsx() {
    window.location.href = `/v1/exports/journal?${buildQuery()}`;
  }

  return (
    <div>
      <h2>仕訳帳 Export</h2>
      <p className="text-sm text-subtle mb-3">
        transactions + apportionment_rules の resolve 結果を仕訳帳 (calc 互換 .xlsx) として書き出す。
      </p>

      <YearTabs
        value={year}
        onChange={(y, range) => {
          setYear(y);
          setFrom(range?.date_from ?? "");
          setTo(range?.date_to ?? "");
        }}
      />

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem", fontSize: "0.85rem" }}>
        <label>from <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>start no. <input type="number" value={startNo} onChange={(e) => setStartNo(parseInt(e.target.value) || 1)} min={1} style={{ width: 70 }} /></label>
        <button className="btn secondary" onClick={() => void loadPreview()} disabled={loading}>preview</button>
        <button className="btn" onClick={downloadXlsx}>.xlsx download</button>
      </div>

      {err && <p className="error">{err}</p>}
      {preview && (
        <>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{preview.length} entries</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>№</th>
                <th style={{ textAlign: "left", padding: "0.3rem" }}>date</th>
                <th style={{ textAlign: "left", padding: "0.3rem" }}>借方</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>借方金額</th>
                <th style={{ textAlign: "left", padding: "0.3rem" }}>貸方</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>貸方金額</th>
                <th style={{ textAlign: "left", padding: "0.3rem" }}>摘要</th>
                <th style={{ textAlign: "right", padding: "0.3rem" }}>按分率</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((e) => (
                <tr key={`${e.no}`} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ textAlign: "right", padding: "0.3rem", color: "var(--muted)" }}>{e.no}</td>
                  <td style={{ padding: "0.3rem" }}>{e.date}</td>
                  <td style={{ padding: "0.3rem" }}>{e.debit_code} {e.debit_name}</td>
                  <td style={{ textAlign: "right", padding: "0.3rem" }}>¥{e.debit_amount.toLocaleString()}</td>
                  <td style={{ padding: "0.3rem", color: "var(--muted)" }}>{e.credit_code} {e.credit_name}</td>
                  <td style={{ textAlign: "right", padding: "0.3rem", color: "var(--muted)" }}>¥{e.credit_amount.toLocaleString()}</td>
                  <td style={{ padding: "0.3rem", maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.description}</td>
                  <td style={{ textAlign: "right", padding: "0.3rem" }}>{(e.rate * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
