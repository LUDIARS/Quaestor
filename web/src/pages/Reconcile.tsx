import { useEffect, useState } from "react";

interface ReceiptRow {
  id: string;
  ocr_status: string;
  date: string | null;
  payee: string | null;
  total: number | null;
}

interface TxLite {
  id: string;
  date: string;
  amount_out: number | null;
  payee: string | null;
  account: string | null;
}

interface MatchScore {
  date_score: number;
  amount_score: number;
  payee_score: number;
  total: number;
}

interface MatchCandidate {
  transaction: TxLite;
  score: MatchScore;
  confidence: number;
  band: "auto" | "suggest" | "weak";
}

interface Reconciliation {
  id: number;
  receipt_id: string;
  transaction_id: string;
  matched_by: string;
  confidence: number;
}

export function Reconcile() {
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [recons, setRecons] = useState<Reconciliation[]>([]);
  const [candidates, setCandidates] = useState<Record<string, MatchCandidate[]>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [autoMatching, setAutoMatching] = useState(false);
  const [autoResult, setAutoResult] = useState<{ matched: unknown[]; skipped: unknown[] } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [r, recon] = await Promise.all([
        fetch("/v1/receipts?status=done&limit=50").then((r) => r.json() as Promise<{ items: ReceiptRow[] }>),
        fetch("/v1/reconciliations").then((r) => r.json() as Promise<{ items: Reconciliation[] }>),
      ]);
      setReceipts(r.items);
      setRecons(recon.items);
      setLoading(false);
      // 各 receipt の候補も並列で
      const reconciled = new Set(recon.items.map((x) => x.receipt_id));
      const byReceipt: Record<string, MatchCandidate[]> = {};
      await Promise.all(r.items
        .filter((x) => !reconciled.has(x.id))
        .map(async (x) => {
          const j = await (await fetch(`/v1/reconciliations/match-candidates/${x.id}`)).json() as { candidates: MatchCandidate[] };
          byReceipt[x.id] = j.candidates;
        }));
      setCandidates(byReceipt);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function confirm(receiptId: string, txId: string, confidence: number, matchedBy: "manual" | "auto" = "manual") {
    try {
      const res = await fetch("/v1/reconciliations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipt_id: receiptId, transaction_id: txId, confidence, matched_by: matchedBy }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        throw new Error(j.error ?? `${res.status}`);
      }
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function unlink(reconId: number) {
    if (!window.confirm("リンク解除しますか?")) return;
    await fetch(`/v1/reconciliations/${reconId}`, { method: "DELETE" });
    await load();
  }

  async function autoMatch() {
    setAutoMatching(true);
    try {
      const res = await fetch("/v1/reconciliations/auto-match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 0.85 }),
      });
      const j = await res.json() as { matched: unknown[]; skipped: unknown[] };
      setAutoResult(j);
      await load();
    } finally {
      setAutoMatching(false);
    }
  }

  if (loading) return <p>loading…</p>;
  if (err) return <p className="error">{err}</p>;

  const reconciled = new Set(recons.map((x) => x.receipt_id));
  const pending = receipts.filter((x) => !reconciled.has(x.id));

  return (
    <div>
      <h2>Reconcile</h2>

      <section style={{ marginBottom: "1rem" }}>
        <button className="btn" onClick={() => void autoMatch()} disabled={autoMatching || pending.length === 0}>
          {autoMatching ? "matching…" : `auto-match (threshold 0.85, ${pending.length} pending)`}
        </button>
        {autoResult && (
          <span style={{ marginLeft: "0.75rem", fontSize: "0.85rem", color: "var(--muted)" }}>
            matched <strong style={{ color: "var(--ok)" }}>{autoResult.matched.length}</strong>、 skipped {autoResult.skipped.length}
          </span>
        )}
      </section>

      <h3 style={{ fontSize: "1rem" }}>承認待ち receipts ({pending.length})</h3>
      {pending.length === 0 && <p style={{ color: "var(--muted)" }}>全件 reconcile 済 or OCR 未完。</p>}
      {pending.map((r) => (
        <div key={r.id} className="last-capture">
          <div>
            <code>{r.id.slice(0, 8)}…</code> ｜ {r.date ?? "-"} ｜ <strong>{r.payee ?? "-"}</strong> ｜
            ¥{r.total?.toLocaleString() ?? "-"}
          </div>
          <ul style={{ marginTop: "0.5rem", listStyle: "none", padding: 0, fontSize: "0.85rem" }}>
            {(candidates[r.id] ?? []).map((c) => (
              <li key={c.transaction.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.3rem 0" }}>
                <span style={{
                  display: "inline-block", padding: "0.1rem 0.4rem", borderRadius: 3, fontSize: "0.7rem",
                  background: c.band === "auto" ? "var(--ok)" : c.band === "suggest" ? "#888" : "var(--danger)",
                  color: "white",
                }}>
                  {c.band} {(c.confidence * 100).toFixed(0)}%
                </span>
                <span>{c.transaction.date}</span>
                <span>{c.transaction.payee ?? "-"}</span>
                <span>¥{c.transaction.amount_out?.toLocaleString() ?? "-"}</span>
                <span style={{ color: "var(--muted)" }}>{c.transaction.account ?? "-"}</span>
                <button className="btn secondary" style={{ marginLeft: "auto", padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                  onClick={() => void confirm(r.id, c.transaction.id, c.confidence)}>
                  link
                </button>
              </li>
            ))}
            {(!candidates[r.id] || candidates[r.id]!.length === 0) && (
              <li style={{ color: "var(--muted)" }}>候補なし</li>
            )}
          </ul>
        </div>
      ))}

      <h3 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>確定済 ({recons.length})</h3>
      {recons.length === 0 ? <p style={{ color: "var(--muted)" }}>まだ無し</p> : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {recons.map((r) => (
            <li key={r.id} style={{ padding: "0.4rem 0", borderBottom: "1px solid var(--border)", fontSize: "0.85rem" }}>
              #{r.id} ｜ receipt <code>{r.receipt_id.slice(0, 8)}</code> ⇄ tx <code>{r.transaction_id.slice(0, 8)}</code> ｜
              <span style={{ marginLeft: "0.5rem" }}>by {r.matched_by} ({(r.confidence * 100).toFixed(0)}%)</span>
              <button className="btn secondary" style={{ marginLeft: "0.5rem", padding: "0.15rem 0.4rem", fontSize: "0.75rem" }}
                onClick={() => void unlink(r.id)}>
                unlink
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
