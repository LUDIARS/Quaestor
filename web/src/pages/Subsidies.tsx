import { useEffect, useState } from "react";
import { NotifyDiscordButton } from "../components/NotifyDiscordButton.js";

interface SubsidyRow {
  id: number; name: string; agency: string | null; kind: string; url: string | null;
  summary: string | null; target: string | null; requirements: string | null;
  max_amount: number | null; subsidy_rate: number | null; deadline: string | null;
  status: string; notes: string | null;
}
interface PlanListItem { id: string; name: string }
interface MatchRow { subsidy_id: number; fit: string; reasoning: string; subsidy: SubsidyRow | null }
interface Candidate {
  external_id: string; name: string; agency: string | null; kind: string; url: string | null;
  summary: string | null; target: string | null; requirements: string | null;
  max_amount: number | null; subsidy_rate: number | null; deadline: string | null;
  status: string; metadata?: Record<string, unknown> | null; already_saved?: boolean;
}
interface Suggestion { candidate: Candidate; fit: string; reasoning: string; already_saved: boolean }

const KIND_LABEL: Record<string, string> = { subsidy: "補助金", grant: "助成金", loan: "融資", other: "その他" };
const STATUS_LABEL: Record<string, string> = { open: "募集中", upcoming: "予定", closed: "終了" };
const FIT_LABEL: Record<string, string> = { high: "適合", medium: "条件次第", low: "対象外寄り" };
const FIT_COLOR: Record<string, string> = { high: "var(--ok)", medium: "#c80", low: "var(--muted)" };

const EMPTY = {
  name: "", agency: "", kind: "subsidy", url: "", summary: "", target: "", requirements: "",
  max_amount: "", subsidy_rate: "", deadline: "", status: "open", notes: "",
};

export function Subsidies() {
  const [list, setList] = useState<SubsidyRow[]>([]);
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [matchPlan, setMatchPlan] = useState("");
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [matching, setMatching] = useState(false);
  const [crawlKw, setCrawlKw] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [crawling, setCrawling] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  async function load() {
    try {
      const [lj, pj] = await Promise.all([
        fetch("/v1/subsidies").then((r) => r.json() as Promise<{ items: SubsidyRow[] }>),
        fetch("/v1/business-plans").then((r) => r.json() as Promise<{ items: PlanListItem[] }>),
      ]);
      setList(lj.items);
      setPlans(pj.items);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { void load(); }, []);

  async function create() {
    setErr(null);
    if (!form.name.trim()) { setErr("名称は必須です"); return; }
    const body: Record<string, unknown> = {
      name: form.name.trim(), agency: form.agency || null, kind: form.kind, url: form.url || null,
      summary: form.summary || null, target: form.target || null, requirements: form.requirements || null,
      deadline: form.deadline || null, status: form.status, notes: form.notes || null,
      max_amount: form.max_amount ? parseInt(form.max_amount.replace(/[,\s]/g, ""), 10) : null,
      subsidy_rate: form.subsidy_rate ? Number(form.subsidy_rate) : null,
    };
    try {
      const res = await fetch("/v1/subsidies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status}`);
      setCreating(false); setForm({ ...EMPTY }); await load();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function setStatus(id: number, status: string) {
    await fetch(`/v1/subsidies/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    await load();
  }
  async function remove(id: number) {
    if (!confirm("削除しますか?")) return;
    await fetch(`/v1/subsidies/${id}`, { method: "DELETE" });
    await load();
  }

  async function runMatch() {
    if (!matchPlan) { setErr("計画を選んでください"); return; }
    setMatching(true); setErr(null); setMatches(null);
    try {
      const r = await fetch("/v1/subsidies/match", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan_id: matchPlan }),
      }).then((r) => r.json() as Promise<{ matches: MatchRow[]; disabled?: boolean; reason?: string }>);
      if (r.disabled || (r.matches.length === 0 && r.reason)) setErr(r.reason ?? "マッチング不可");
      setMatches(r.matches);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setMatching(false);
  }

  async function runCrawl() {
    if (crawlKw.trim().length < 2) { setErr("キーワードは2文字以上"); return; }
    setCrawling(true); setErr(null); setCandidates(null);
    try {
      const r = await fetch("/v1/subsidies/crawl", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: crawlKw.trim() }),
      }).then((r) => r.json() as Promise<{ candidates: Candidate[]; disabled?: boolean; reason?: string }>);
      if (r.disabled) setErr(r.reason ?? "クロール不可");
      setCandidates(r.candidates);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setCrawling(false);
  }

  async function importOne(cand: Candidate) {
    await fetch("/v1/subsidies/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidates: [cand] }),
    });
    await load();
    // 取込済みフラグを反映
    setCandidates((cs) => cs?.map((c) => (c.external_id === cand.external_id ? { ...c, already_saved: true } : c)) ?? null);
    setSuggestions((ss) => ss?.map((s) => (s.candidate.external_id === cand.external_id ? { ...s, already_saved: true } : s)) ?? null);
  }

  async function runSuggest() {
    if (!matchPlan) { setErr("計画を選んでください"); return; }
    setSuggesting(true); setErr(null); setSuggestions(null);
    try {
      const r = await fetch("/v1/subsidies/suggest", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan_id: matchPlan }),
      }).then((r) => r.json() as Promise<{ suggestions: Suggestion[]; keywords: string[]; disabled?: boolean; reason?: string }>);
      if (r.disabled) setErr(r.reason ?? "提案不可");
      setSuggestions(r.suggestions);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setSuggesting(false);
  }

  return (
    <div className="foundation-form">
      <h2>補助金・助成金</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        資金調達に使える補助金・助成金・制度融資を登録し、 事業計画との要件マッチングにかけます。
      </p>
      {err && <p className="error">{err}</p>}

      {/* マッチング */}
      <section className="last-capture" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
        <h3 style={{ margin: "0 0 0.5rem" }}>計画に合う補助金を診断</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <select value={matchPlan} onChange={(e) => setMatchPlan(e.target.value)}>
            <option value="">事業計画を選択…</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn" onClick={() => void runMatch()} disabled={matching || !matchPlan}>
            {matching ? "診断中…(LLM)" : "登録済みから診断"}
          </button>
          <button className="btn" onClick={() => void runSuggest()} disabled={suggesting || !matchPlan}>
            {suggesting ? "提案中…(クロール+LLM)" : "jGrants から提案"}
          </button>
          {matchPlan && <NotifyDiscordButton endpoint="/v1/notify/subsidies" body={{ plan_id: matchPlan }} label="提案を Discord に通知" />}
        </div>
        {matches && matches.length > 0 && (
          <ul style={{ margin: "0.6rem 0 0", paddingLeft: "1.1rem", fontSize: "0.83rem" }}>
            {matches.map((m) => (
              <li key={m.subsidy_id} style={{ marginBottom: "0.35rem" }}>
                <span style={{ color: FIT_COLOR[m.fit], fontWeight: 600 }}>[{FIT_LABEL[m.fit] ?? m.fit}]</span>{" "}
                {m.subsidy?.name ?? `#${m.subsidy_id}`}
                <div style={{ color: "var(--muted)", fontSize: "0.78rem" }}>{m.reasoning}</div>
              </li>
            ))}
          </ul>
        )}
        {suggestions && (
          <div style={{ marginTop: "0.6rem" }}>
            <div style={{ color: "var(--muted)", fontSize: "0.75rem", marginBottom: 4 }}>jGrants 募集中から提案 ({suggestions.length}件)</div>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.83rem" }}>
              {suggestions.map((s) => (
                <li key={s.candidate.external_id} style={{ marginBottom: "0.4rem" }}>
                  <span style={{ color: FIT_COLOR[s.fit], fontWeight: 600 }}>[{FIT_LABEL[s.fit] ?? s.fit}]</span>{" "}
                  {s.candidate.url ? <a href={s.candidate.url} target="_blank" rel="noreferrer">{s.candidate.name}</a> : s.candidate.name}
                  {s.candidate.max_amount != null && <span style={{ color: "var(--muted)" }}> ・上限¥{s.candidate.max_amount.toLocaleString()}</span>}
                  {s.candidate.deadline && <span style={{ color: "var(--muted)" }}> ・締切{s.candidate.deadline}</span>}
                  {s.already_saved
                    ? <span style={{ color: "var(--ok)", fontSize: "0.72rem", marginLeft: 6 }}>取込済</span>
                    : <button className="btn" style={{ marginLeft: 6, padding: "0 0.5rem", fontSize: "0.72rem" }} onClick={() => void importOne(s.candidate)}>取込</button>}
                  <div style={{ color: "var(--muted)", fontSize: "0.78rem" }}>{s.reasoning}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* jGrants キーワード検索 */}
      <section className="last-capture" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
        <h3 style={{ margin: "0 0 0.5rem" }}>jGrants から検索して取込</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input type="text" value={crawlKw} onChange={(e) => setCrawlKw(e.target.value)} placeholder="例: 創業 / 販路開拓 / IT導入"
            onKeyDown={(e) => { if (e.key === "Enter") void runCrawl(); }} style={{ minWidth: 200 }} />
          <button className="btn" onClick={() => void runCrawl()} disabled={crawling}>{crawling ? "検索中…" : "検索"}</button>
        </div>
        {candidates && candidates.length === 0 && <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>該当なし</p>}
        {candidates && candidates.length > 0 && (
          <ul style={{ margin: "0.6rem 0 0", paddingLeft: "1.1rem", fontSize: "0.83rem" }}>
            {candidates.map((c) => (
              <li key={c.external_id} style={{ marginBottom: "0.4rem" }}>
                {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}
                {c.max_amount != null && <span style={{ color: "var(--muted)" }}> ・上限¥{c.max_amount.toLocaleString()}</span>}
                {c.subsidy_rate != null && <span style={{ color: "var(--muted)" }}> ・{Math.round(c.subsidy_rate * 100)}%</span>}
                {c.deadline && <span style={{ color: "var(--muted)" }}> ・締切{c.deadline}</span>}
                {c.already_saved
                  ? <span style={{ color: "var(--ok)", fontSize: "0.72rem", marginLeft: 6 }}>取込済</span>
                  : <button className="btn" style={{ marginLeft: 6, padding: "0 0.5rem", fontSize: "0.72rem" }} onClick={() => void importOne(c)}>取込</button>}
                {c.target && <div style={{ color: "var(--muted)", fontSize: "0.74rem" }}>{c.target}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button className="btn" onClick={() => setCreating((v) => !v)} style={{ marginBottom: "0.75rem" }}>
        {creating ? "閉じる" : "+ 補助金を登録"}
      </button>
      {creating && (
        <section className="last-capture" style={{ marginBottom: "1rem", maxWidth: 620 }}>
          <div style={{ display: "grid", gap: "0.4rem", fontSize: "0.85rem" }}>
            <label>名称 <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例: 小規模事業者持続化補助金" /></label>
            <label>実施機関 <input type="text" value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })} /></label>
            <label>種別
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>対象者 <input type="text" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="例: 創業5年以内の小規模事業者" /></label>
            <label>要件 <textarea value={form.requirements} onChange={(e) => setForm({ ...form, requirements: e.target.value })} rows={3} placeholder="1行1要件で記載" /></label>
            <label>上限額(円) <input type="text" inputMode="numeric" value={form.max_amount} onChange={(e) => setForm({ ...form, max_amount: e.target.value })} style={{ width: 160 }} /></label>
            <label>補助率(0〜1) <input type="text" value={form.subsidy_rate} onChange={(e) => setForm({ ...form, subsidy_rate: e.target.value })} style={{ width: 100 }} placeholder="0.67" /></label>
            <label>締切 <input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} /></label>
            <label>URL <input type="text" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></label>
            <label>概要 <textarea value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} rows={2} /></label>
            <button className="btn" onClick={() => void create()}>登録</button>
          </div>
        </section>
      )}

      <table style={{ width: "100%", fontSize: "0.83rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>名称</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>種別</th>
            <th style={{ textAlign: "right", padding: "0.4rem" }}>上限額</th>
            <th style={{ textAlign: "right", padding: "0.4rem" }}>補助率</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>締切</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>状態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "0.4rem" }}>
                {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> : s.name}
                {s.agency && <div style={{ color: "var(--muted)", fontSize: "0.72rem" }}>{s.agency}</div>}
              </td>
              <td style={{ padding: "0.4rem" }}>{KIND_LABEL[s.kind] ?? s.kind}</td>
              <td style={{ padding: "0.4rem", textAlign: "right" }}>{s.max_amount != null ? `¥${s.max_amount.toLocaleString()}` : "-"}</td>
              <td style={{ padding: "0.4rem", textAlign: "right" }}>{s.subsidy_rate != null ? `${Math.round(s.subsidy_rate * 100)}%` : "-"}</td>
              <td style={{ padding: "0.4rem", whiteSpace: "nowrap" }}>{s.deadline ?? "-"}</td>
              <td style={{ padding: "0.4rem" }}>
                <select value={s.status} onChange={(e) => void setStatus(s.id, e.target.value)}>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </td>
              <td><button className="btn" onClick={() => void remove(s.id)} style={{ color: "var(--err, #d33)" }}>削除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p style={{ color: "var(--muted)", marginTop: "0.5rem" }}>まだ登録がありません。</p>}
    </div>
  );
}
