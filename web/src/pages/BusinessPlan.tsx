import { useEffect, useState } from "react";

// ── 型 (backend と対応) ──
interface TemplateSection { key: string; title: string; hint?: string }
interface TemplateInfo {
  id: string;
  name: string;
  purpose: string;
  horizon_years: number;
  description: string;
  sections: TemplateSection[];
}
interface SectionRow { id: number; key: string; body: string; display_order: number }
interface FigureRow { id: number; category: string; label: string; period: string; amount: number | null; source: string }
interface Finding { severity: "error" | "warning" | "info"; area: string; code: string; message: string; suggestion?: string }
interface ReviewRow {
  id: number; kind: string; score: number | null; summary: string | null;
  findings: string; metrics: string | null; model: string | null; created_at: number;
}
interface PlanDetail {
  id: string; name: string; template: string; purpose: string; status: string;
  fiscal_start: string | null; horizon_years: number; notes: string | null;
  sections: SectionRow[]; figures: FigureRow[]; latest_review: ReviewRow | null;
}
interface PlanListItem { id: string; name: string; template: string; purpose: string; status: string; updated_at: number }

const PURPOSE_LABEL: Record<string, string> = { funding: "融資", subsidy: "補助金", internal: "社内" };
const STATUS_LABEL: Record<string, string> = { draft: "下書き", review: "レビュー中", final: "確定" };
const SEV_COLOR: Record<string, string> = { error: "var(--err, #d33)", warning: "#c80", info: "var(--muted)" };
const CATEGORY_LABEL: Record<string, string> = {
  sales: "売上高", cogs: "売上原価", sga: "販管費", fixed_cost: "固定費",
  use_of_funds: "資金使途", funding: "資金調達", repayment: "返済", cashflow: "資金繰り",
  value_added: "付加価値額", labor_cost: "人件費", depreciation: "減価償却費",
};

function periodRank(p: string): number {
  if (p === "base") return 0;
  if (p.startsWith("Y")) return 100 + parseInt(p.slice(1), 10);
  if (p.startsWith("M")) return 200 + parseInt(p.slice(1), 10);
  return 999;
}
function periodLabel(p: string): string {
  if (p === "base") return "金額";
  if (p.startsWith("Y")) return `${p.slice(1)}期`;
  if (p.startsWith("M")) return `${p.slice(1)}月`;
  return p;
}

export function BusinessPlan() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [list, setList] = useState<PlanListItem[]>([]);
  const [selected, setSelected] = useState<PlanDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("jfc_startup");

  async function loadList() {
    try {
      const [tj, lj] = await Promise.all([
        fetch("/v1/business-plans/templates").then((r) => r.json() as Promise<{ templates: TemplateInfo[] }>),
        fetch("/v1/business-plans").then((r) => r.json() as Promise<{ items: PlanListItem[] }>),
      ]);
      setTemplates(tj.templates);
      setList(lj.items);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { void loadList(); }, []);

  async function openPlan(id: string) {
    setErr(null);
    const j = await fetch(`/v1/business-plans/${id}`).then((r) => r.json() as Promise<{ plan: PlanDetail }>);
    setSelected(j.plan);
  }

  async function create() {
    setErr(null);
    if (!newName.trim()) { setErr("計画名を入力してください"); return; }
    try {
      const res = await fetch("/v1/business-plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), template: newTemplate }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = await res.json() as { plan: PlanDetail };
      setCreating(false);
      setNewName("");
      await loadList();
      setSelected(j.plan);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function remove(id: string) {
    if (!confirm("この計画を削除しますか?")) return;
    await fetch(`/v1/business-plans/${id}`, { method: "DELETE" });
    setSelected(null);
    await loadList();
  }

  if (selected) {
    return (
      <PlanEditor
        plan={selected}
        templates={templates}
        onBack={() => { setSelected(null); void loadList(); }}
        onReload={() => openPlan(selected.id)}
        onDelete={() => remove(selected.id)}
      />
    );
  }

  return (
    <div className="foundation-form">
      <h2>事業計画レビュー</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        資金調達 (融資・補助金) 用の事業計画を、 書類形式に沿って作成し、 定量検算 + Claude レビューにかけます。
      </p>

      {err && <p className="error">{err}</p>}

      <button className="btn" onClick={() => setCreating((v) => !v)} style={{ marginBottom: "0.75rem" }}>
        {creating ? "閉じる" : "+ 新規作成"}
      </button>
      {creating && (
        <section className="last-capture" style={{ marginBottom: "1rem", maxWidth: 560 }}>
          <div style={{ display: "grid", gap: "0.5rem", fontSize: "0.85rem" }}>
            <label>計画名 <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例: ○○カフェ 創業計画" /></label>
            <label>書類テンプレート
              <select value={newTemplate} onChange={(e) => setNewTemplate(e.target.value)}>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            {templates.find((t) => t.id === newTemplate) && (
              <p style={{ color: "var(--muted)", fontSize: "0.78rem", margin: 0 }}>
                {templates.find((t) => t.id === newTemplate)!.description}
              </p>
            )}
            <button className="btn" onClick={() => void create()}>作成</button>
          </div>
        </section>
      )}

      <table style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>計画名</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>テンプレート</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>目的</th>
            <th style={{ textAlign: "left", padding: "0.4rem" }}>状態</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => void openPlan(p.id)}>
              <td style={{ padding: "0.4rem", color: "var(--accent, #06c)" }}>{p.name}</td>
              <td style={{ padding: "0.4rem" }}>{templates.find((t) => t.id === p.template)?.name ?? p.template}</td>
              <td style={{ padding: "0.4rem" }}>{PURPOSE_LABEL[p.purpose] ?? p.purpose}</td>
              <td style={{ padding: "0.4rem" }}>{STATUS_LABEL[p.status] ?? p.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p style={{ color: "var(--muted)", marginTop: "0.5rem" }}>まだ計画がありません。「+ 新規作成」から始めてください。</p>}
    </div>
  );
}

// ── 計画エディタ ──
function PlanEditor(props: {
  plan: PlanDetail;
  templates: TemplateInfo[];
  onBack: () => void;
  onReload: () => Promise<void>;
  onDelete: () => void;
}) {
  const { plan, templates } = props;
  const tpl = templates.find((t) => t.id === plan.template);
  const [sections, setSections] = useState<Record<string, string>>(() =>
    Object.fromEntries(plan.sections.map((s) => [s.key, s.body])),
  );
  const [figEdits, setFigEdits] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [review, setReview] = useState<{ score: number; summary: string; findings: Finding[]; metrics: unknown; kind: string; downgraded?: boolean } | null>(
    plan.latest_review
      ? {
          score: plan.latest_review.score ?? 0,
          summary: plan.latest_review.summary ?? "",
          findings: safeParse<Finding[]>(plan.latest_review.findings, []),
          metrics: plan.latest_review.metrics ? safeParse(plan.latest_review.metrics, null) : null,
          kind: plan.latest_review.kind,
        }
      : null,
  );

  function sectionTitle(key: string): string {
    return tpl?.sections.find((s) => s.key === key)?.title ?? key;
  }
  function sectionHint(key: string): string | undefined {
    return tpl?.sections.find((s) => s.key === key)?.hint;
  }

  async function saveSection(key: string) {
    setBusy(`section:${key}`); setErr(null);
    try {
      await fetch(`/v1/business-plans/${plan.id}/sections/${key}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: sections[key] ?? "" }),
      });
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  }

  async function saveFigures() {
    const changed = plan.figures
      .filter((f) => figEdits[f.id] !== undefined)
      .map((f) => ({
        category: f.category, label: f.label, period: f.period,
        amount: figEdits[f.id]!.trim() === "" ? null : parseInt(figEdits[f.id]!.replace(/[,\s]/g, ""), 10),
      }))
      .filter((f) => f.amount === null || Number.isFinite(f.amount));
    if (changed.length === 0) return;
    setBusy("figures"); setErr(null);
    try {
      await fetch(`/v1/business-plans/${plan.id}/figures`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ figures: changed }),
      });
      setFigEdits({});
      await props.onReload();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  }

  async function seedActuals() {
    setBusy("seed"); setErr(null);
    try {
      const r = await fetch(`/v1/business-plans/${plan.id}/seed-from-actuals`, { method: "POST" })
        .then((r) => r.json() as Promise<{ year: number | null; applied: unknown[] }>);
      if (r.year === null) setErr("取り込める実績 (決算書) がありません。");
      await props.onReload();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  }

  async function runReview(kind: string) {
    setBusy(`review:${kind}`); setErr(null);
    try {
      const r = await fetch(`/v1/business-plans/${plan.id}/review?kind=${kind}`, { method: "POST" })
        .then((r) => r.json() as Promise<{ result: { score: number; summary: string; findings: Finding[]; metrics: unknown; kind: string }; downgraded: boolean }>);
      setReview({ ...r.result, downgraded: r.downgraded });
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  }

  // figures を category ごとにグループ化、 各 category の period 列を集める
  const categories = [...new Set(plan.figures.map((f) => f.category))];

  return (
    <div className="foundation-form">
      <button className="btn" onClick={props.onBack} style={{ marginBottom: "0.75rem" }}>← 一覧へ</button>
      <h2 style={{ marginBottom: 0 }}>{plan.name}</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 4 }}>
        {tpl?.name} ・ {PURPOSE_LABEL[plan.purpose] ?? plan.purpose} ・ {plan.horizon_years}期計画
      </p>

      {err && <p className="error">{err}</p>}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", margin: "0.5rem 0 1rem" }}>
        <button className="btn" onClick={() => void seedActuals()} disabled={busy === "seed"}>
          {busy === "seed" ? "取込中…" : "実績から取り込み"}
        </button>
        <button className="btn" onClick={() => void runReview("quantitative")} disabled={!!busy}>定量検算のみ</button>
        <button className="btn" onClick={() => void runReview("combined")} disabled={!!busy}>
          {busy === "review:combined" ? "レビュー中…" : "レビュー実行 (定量+定性)"}
        </button>
        <button className="btn" onClick={props.onDelete} style={{ marginLeft: "auto", color: "var(--err, #d33)" }}>削除</button>
      </div>

      {review && <ReviewPanel review={review} />}

      {/* 数字 */}
      <h3>数字</h3>
      {categories.map((cat) => {
        const rows = plan.figures.filter((f) => f.category === cat);
        const periods = [...new Set(rows.map((f) => f.period))].sort((a, b) => periodRank(a) - periodRank(b));
        const labels = [...new Set(rows.map((f) => f.label))];
        return (
          <section key={cat} style={{ marginBottom: "1rem" }}>
            <h4 style={{ margin: "0.5rem 0 0.25rem" }}>{CATEGORY_LABEL[cat] ?? cat}</h4>
            <table style={{ fontSize: "0.82rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "0.3rem 0.5rem" }}>項目</th>
                  {periods.map((p) => <th key={p} style={{ textAlign: "right", padding: "0.3rem 0.5rem" }}>{periodLabel(p)}</th>)}
                </tr>
              </thead>
              <tbody>
                {labels.map((label) => (
                  <tr key={label} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "0.3rem 0.5rem", whiteSpace: "nowrap" }}>{label}</td>
                    {periods.map((p) => {
                      const f = rows.find((r) => r.label === label && r.period === p);
                      if (!f) return <td key={p} />;
                      const val = figEdits[f.id] !== undefined ? figEdits[f.id] : (f.amount ?? "").toString();
                      return (
                        <td key={p} style={{ padding: "0.2rem 0.4rem", textAlign: "right" }}>
                          <input
                            type="text" inputMode="numeric" value={val}
                            onChange={(e) => setFigEdits({ ...figEdits, [f.id]: e.target.value })}
                            style={{ width: 110, textAlign: "right", borderColor: f.source === "from_actuals" ? "var(--ok)" : undefined }}
                            title={f.source === "from_actuals" ? "実績から取込" : undefined}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      <button className="btn" onClick={() => void saveFigures()} disabled={busy === "figures" || Object.keys(figEdits).length === 0}>
        {busy === "figures" ? "保存中…" : `数字を保存 (${Object.keys(figEdits).length})`}
      </button>

      {/* 記述 */}
      <h3 style={{ marginTop: "1.5rem" }}>記述</h3>
      {plan.sections.map((s) => (
        <section key={s.key} style={{ marginBottom: "1rem", maxWidth: 720 }}>
          <label style={{ fontWeight: 600 }}>{sectionTitle(s.key)}</label>
          {sectionHint(s.key) && <p style={{ color: "var(--muted)", fontSize: "0.75rem", margin: "0.2rem 0" }}>{sectionHint(s.key)}</p>}
          <textarea
            value={sections[s.key] ?? ""} rows={4} style={{ width: "100%" }}
            onChange={(e) => setSections({ ...sections, [s.key]: e.target.value })}
            onBlur={() => void saveSection(s.key)}
          />
        </section>
      ))}
    </div>
  );
}

function ReviewPanel({ review }: { review: { score: number; summary: string; findings: Finding[]; metrics: unknown; kind: string; downgraded?: boolean } }) {
  const m = review.metrics as null | {
    funding?: { ownFundsRatio: number | null; balanced: boolean } | null;
    breakEven?: { breakEvenSales: number | null } | null;
    cashflow?: { shortageMonth: number | null } | null;
  };
  return (
    <section className="last-capture" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
        <span style={{ fontSize: "1.6rem", fontWeight: 700, color: review.score >= 70 ? "var(--ok)" : review.score >= 40 ? "#c80" : "var(--err, #d33)" }}>
          {review.score}
        </span>
        <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>/100 ({review.kind})</span>
        {review.downgraded && <span style={{ color: "#c80", fontSize: "0.75rem" }}>※ API key 無しのため定量のみ</span>}
      </div>
      {review.summary && <p style={{ fontSize: "0.86rem", margin: "0.4rem 0" }}>{review.summary}</p>}
      {m && (
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", fontSize: "0.76rem", color: "var(--muted)", margin: "0.3rem 0" }}>
          {m.funding && <span>自己資金比率 {m.funding.ownFundsRatio !== null ? `${(m.funding.ownFundsRatio * 100).toFixed(1)}%` : "—"}{!m.funding.balanced && " (調達=使途不一致)"}</span>}
          {m.breakEven?.breakEvenSales != null && <span>損益分岐点 ¥{m.breakEven.breakEvenSales.toLocaleString()}</span>}
          {m.cashflow && <span>資金繰り {m.cashflow.shortageMonth !== null ? `${m.cashflow.shortageMonth}月ショート` : "ショートなし"}</span>}
        </div>
      )}
      {review.findings.length === 0 ? (
        <p style={{ color: "var(--ok)", fontSize: "0.82rem" }}>指摘なし。</p>
      ) : (
        <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.82rem" }}>
          {review.findings.map((f, i) => (
            <li key={i} style={{ marginBottom: "0.35rem" }}>
              <span style={{ color: SEV_COLOR[f.severity], fontWeight: 600 }}>[{f.severity}]</span>{" "}
              <span style={{ color: "var(--muted)" }}>{f.area}:</span> {f.message}
              {f.suggestion && <div style={{ color: "var(--muted)", fontSize: "0.76rem", marginLeft: "0.5rem" }}>→ {f.suggestion}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
