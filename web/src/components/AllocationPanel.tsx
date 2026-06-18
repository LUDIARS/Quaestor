import { useEffect, useState } from "react";

interface AllocationLine { asset_class: string; current_pct: number; target_pct: number; action: string; rationale: string }
interface AssetIdea { name: string; kind: string; tax_wrapper: string | null; rationale: string }
interface Advice {
  summary: string;
  risk_profile: string;
  target_allocation: AllocationLine[];
  investment_capacity: { suggested_monthly: number | null; note: string };
  asset_ideas: AssetIdea[];
}
interface Stored { available?: boolean; advice?: Advice; generated_at?: number; disabled?: boolean; reason?: string; error?: string }

const RISK_LABEL: Record<string, string> = { conservative: "低リスク重視", balanced: "中庸", aggressive: "成長重視" };
const ACTION: Record<string, { label: string; color: string }> = {
  increase: { label: "増", color: "var(--ok)" }, decrease: { label: "減", color: "var(--err, #d33)" }, hold: { label: "維持", color: "var(--muted)" },
};

/** ポートフォリオから資産配分・投資幅・金融資産を論拠付きで提案するパネル */
export function AllocationPanel() {
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [risk, setRisk] = useState("balanced");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadCached() {
    try {
      const r = await fetch("/v1/portfolio/allocation").then((res) => res.json() as Promise<Stored>);
      if (r.available && r.advice) { setAdvice(r.advice); setGeneratedAt(r.generated_at ?? null); }
    } catch { /* ignore */ }
  }
  useEffect(() => { void loadCached(); }, []);

  async function recommend() {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { risk };
      if (goal.trim()) body.goal = goal.trim();
      if (budget.trim()) body.monthly_budget = parseInt(budget.replace(/[,\s]/g, ""), 10);
      const r = await fetch("/v1/portfolio/allocation/recommend", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }).then((res) => res.json() as Promise<Stored>);
      if (r.disabled) setMsg(r.reason ?? "提案不可 (claude CLI 要)");
      else if (r.error) setMsg(r.error);
      else if (r.advice) { setAdvice(r.advice); setGeneratedAt(r.generated_at ?? null); }
    } catch (e: unknown) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }

  return (
    <section className="last-capture" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
      <h3 style={{ margin: "0 0 0.5rem" }}>資産配分の提案 (論拠付き)</h3>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", fontSize: "0.85rem" }}>
        <label>リスク許容度
          <select value={risk} onChange={(e) => setRisk(e.target.value)}>
            {Object.entries(RISK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>目標 <input type="text" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="例: 20年で老後資金2000万" style={{ minWidth: 200 }} /></label>
        <label>月の投資余力 <input type="text" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="円" style={{ width: 110 }} /></label>
        <button className="btn" onClick={() => void recommend()} disabled={busy}>{busy ? "提案中…(LLM)" : "提案する"}</button>
      </div>
      {msg && <p className="error" style={{ marginTop: "0.4rem" }}>{msg}</p>}

      {advice && (
        <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          <p style={{ margin: "0 0 0.6rem" }}>{advice.summary}</p>

          <div style={{ color: "var(--muted)", fontSize: "0.78rem", marginBottom: 4 }}>目標配分 (現状→目標)</div>
          <table style={{ borderCollapse: "collapse", fontSize: "0.82rem", marginBottom: "0.75rem" }}>
            <tbody>
              {advice.target_allocation.map((l, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "0.3rem 0.5rem", whiteSpace: "nowrap" }}>{l.asset_class}</td>
                  <td style={{ padding: "0.3rem 0.5rem", textAlign: "right", color: "var(--muted)" }}>{l.current_pct.toFixed(0)}%</td>
                  <td style={{ padding: "0.3rem 0.5rem", textAlign: "center" }}>→</td>
                  <td style={{ padding: "0.3rem 0.5rem", textAlign: "right", fontWeight: 600 }}>{l.target_pct.toFixed(0)}%</td>
                  <td style={{ padding: "0.3rem 0.5rem", color: ACTION[l.action]?.color ?? "var(--muted)" }}>{ACTION[l.action]?.label ?? l.action}</td>
                  <td style={{ padding: "0.3rem 0.5rem", color: "var(--muted)" }}>{l.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginBottom: "0.75rem" }}>
            <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>投資幅: </span>
            {advice.investment_capacity.suggested_monthly != null && <strong>月 ¥{advice.investment_capacity.suggested_monthly.toLocaleString()} </strong>}
            <span style={{ color: "var(--muted)" }}>{advice.investment_capacity.note}</span>
          </div>

          <div style={{ color: "var(--muted)", fontSize: "0.78rem", marginBottom: 4 }}>金融資産アイデア</div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {advice.asset_ideas.map((idea, i) => (
              <li key={i} style={{ marginBottom: "0.3rem" }}>
                <strong>{idea.name}</strong> <span style={{ color: "var(--muted)" }}>[{idea.kind}{idea.tax_wrapper ? ` / ${idea.tax_wrapper}` : ""}]</span>
                <div style={{ color: "var(--muted)", fontSize: "0.78rem" }}>{idea.rationale}</div>
              </li>
            ))}
          </ul>

          {generatedAt && <div style={{ color: "var(--muted)", fontSize: "0.7rem", marginTop: "0.5rem" }}>生成: {new Date(generatedAt * 1000).toLocaleString("ja-JP")}</div>}
        </div>
      )}
    </section>
  );
}
