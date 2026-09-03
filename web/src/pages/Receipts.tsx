import { useEffect, useState } from "react";
import { ReceiptEditor } from "../components/ReceiptEditor.js";
import { MonthTabs, currentYear, currentMonth, monthRange } from "../components/MonthTabs.js";
import { ReceiptQueue } from "../components/ReceiptQueue.js";
import { DocKindLabels } from "../scan/DocKindLabels.js";
import type { LabeledReceipt } from "../scan/receiptLabelsApi.js";

interface ReceiptRow extends LabeledReceipt {
  captured_at: number;
  image_path: string | null;
  ocr_status: string;
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;
}

function sortByDateAsc(rows: ReceiptRow[]): ReceiptRow[] {
  return [...rows].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });
}

export function Receipts() {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState(currentMonth());

  async function load(y: string, m: string) {
    setLoading(true);
    try {
      const r = monthRange(y, m);
      const params = new URLSearchParams({
        limit: "100",
        date_from: r.date_from,
        date_to: r.date_to,
      });
      const [list, health] = await Promise.all([
        fetch(`/v1/receipts?${params}`).then((r) => r.json() as Promise<{ items: ReceiptRow[] }>),
        fetch("/health").then((r) => r.json() as Promise<{ ocr_enabled?: boolean }>),
      ]);
      setRows(sortByDateAsc(list.items));
      setOcrEnabled(!!health.ocr_enabled);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => { void load(year, month); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [year, month]);

  async function runOcr(id: string) {
    setRunning(id);
    try {
      const res = await fetch(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(j.message ?? j.error ?? `${res.status}`);
      }
      await load(year, month);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  /** 種別・サンプルラベルの上書き (PATCH /labels) を一覧へ反映する。 */
  function onLabelsChanged(u: LabeledReceipt) {
    setRows((prev) => prev.map((r) => (r.id === u.id ? { ...r, ...u } : r)));
  }

  if (loading) return <p>loading…</p>;
  return (
    <div>
      <h2>Receipts ({rows.length}) {ocrEnabled ? <small style={{ color: "var(--ok)" }}>OCR enabled</small> : <small style={{ color: "var(--muted)" }}>OCR disabled (Claude Code で解析する想定)</small>}</h2>
      <ReceiptQueue origin="receipts tab" />
      <MonthTabs
        year={year}
        month={month}
        onYearChange={(y) => setYear(y)}
        onChange={(m) => setMonth(m)}
      />
      {loading && <p>loading…</p>}
      {err && <p className="error">{err} <button className="btn secondary" onClick={() => { setErr(null); void load(year, month); }}>retry</button></p>}
      {!loading && rows.length === 0 && <p className="text-subtle">{year}年{parseInt(month)}月のレシートは無し</p>}
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
            {/* 種別 / サンプルラベル / タグ — バッジをタップして 1 タップで直す */}
            <DocKindLabels receipt={r} onChanged={onLabelsChanged} />
            {editing === r.id && (
              <ReceiptEditor
                receipt={r}
                onSaved={() => void load(year, month)}
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
