import { useEffect, useState, type ReactNode } from "react";

/**
 * 積立ポートフォリオ / 配当アドバイザ。
 * 保有商品 (投信 / 個別株・ETF / 保険型) の積立を管理し、 利回り・将来見通し・
 * 配当株サジェスト (公開情報のみ) を提示する。
 */

// ── 型 ──

type HoldingKind = "fund" | "stock" | "etf" | "insurance" | "other";
type TaxWrapper = "nisa_tsumitate" | "nisa_growth" | "ideco" | "taxable" | "insurance";

interface Ret {
  invested: number;
  market_value: number | null;
  dividends_received: number;
  unrealized_pl: number | null;
  total_return: number | null;
  simple_return_pct: number | null;
  annualized_xirr_pct: number | null;
  planned_to_date: number | null;
  actual_to_date: number;
  variance: number | null;
  variance_pct: number | null;
}

interface Holding {
  id: string;
  kind: HoldingKind;
  name: string;
  account: string | null;
  ticker: string | null;
  currency: string;
  tax_wrapper: TaxWrapper | null;
  target_amount: number | null;
  monthly_contribution: number | null;
  status: string;
  started_at: string | null;
}

interface HoldingSummary {
  holding: Holding;
  latest_valuation: { as_of: string; market_value: number } | null;
  ret: Ret;
}

interface Totals {
  count: number;
  invested: number;
  market_value: number;
  valued_invested: number;
  unrealized_pl: number;
  dividends_received: number;
  simple_return_pct: number | null;
  planned_to_date: number;
  actual_to_date: number;
  variance: number;
  monthly_contribution: number;
}

interface ProjectionPoint { month: number; contributed: number; value: number }
interface Projection {
  months: number;
  rates: { conservative: number; base: number; optimistic: number };
  base: ProjectionPoint[];
  terminal: { conservative: number; base: number; optimistic: number };
  base_months_to_target: number | null;
}

interface DividendCandidate {
  ticker: string;
  company_name: string | null;
  close: number | null;
  dividend_yield_pct: number | null;
  dps_annual: number | null;
  payout_ratio_pct: number | null;
  consecutive_increase_years: number | null;
  ex_rights_months: string | null;
  stability_note: string | null;
  rationale: string | null;
}

const KIND_LABEL: Record<HoldingKind, string> = {
  fund: "投信",
  stock: "個別株",
  etf: "ETF",
  insurance: "保険型",
  other: "その他",
};

const WRAPPER_LABEL: Record<TaxWrapper, string> = {
  nisa_tsumitate: "つみたてNISA",
  nisa_growth: "成長NISA",
  ideco: "iDeCo",
  taxable: "特定/一般",
  insurance: "保険",
};

const yen = (n: number | null | undefined): string => (n == null ? "—" : `¥${Math.round(n).toLocaleString()}`);
const pct = (n: number | null | undefined): string => (n == null ? "—" : `${n}%`);

// ── component ──

export function Portfolio() {
  const [summary, setSummary] = useState<{ holdings: HoldingSummary[]; totals: Totals } | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [candidates, setCandidates] = useState<DividendCandidate[]>([]);
  const [years, setYears] = useState(20);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [sm, pj, cd] = await Promise.all([
        fetch("/v1/portfolio/summary").then((r) => r.json() as Promise<{ holdings: HoldingSummary[]; totals: Totals }>),
        fetch(`/v1/portfolio/projection?years=${years}`).then((r) => r.json() as Promise<Projection>),
        fetch("/v1/portfolio/dividends/candidates").then((r) => r.json() as Promise<{ items: DividendCandidate[] }>),
      ]);
      setSummary(sm);
      setProjection(pj);
      setCandidates(cd.items);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [years]);

  async function run(label: string, path: string, body: Record<string, unknown> = {}) {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json() as { summary?: Record<string, number>; error?: string };
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setMsg(`${label}: ${JSON.stringify(j.summary)}`);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p>loading…</p>;
  const totals = summary?.totals;

  return (
    <div>
      <h2>積立ポートフォリオ / 配当アドバイザ</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: "-0.4rem" }}>
        投信・個別株/ETF・保険型の積立を管理し、 利回り (XIRR) / 計画 vs 実績 / 将来見通し / 配当株を提示します。
        株価/配当は公開情報のみ (インサイダー情報は扱いません)。
      </p>

      {/* ポートフォリオ合計 */}
      {totals && (
        <section className="last-capture" style={{ padding: "0.75rem", marginBottom: "1rem" }}>
          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <Stat label="保有商品" value={`${totals.count} 件`} />
            <Stat label="取得原価 (累計拠出)" value={yen(totals.invested)} />
            <Stat label="評価額" value={yen(totals.market_value)} />
            <Stat label="含み損益" value={yen(totals.unrealized_pl)} accent={totals.unrealized_pl >= 0 ? "ok" : "bad"} />
            <Stat label="トータル利回り" value={pct(totals.simple_return_pct)} accent={(totals.simple_return_pct ?? 0) >= 0 ? "ok" : "bad"} />
            <Stat label="受取配当 (累計)" value={yen(totals.dividends_received)} />
            <Stat label="計画 vs 実績" value={yen(totals.variance)} accent={totals.variance >= 0 ? "ok" : "bad"} />
            <Stat label="毎月の積立額" value={yen(totals.monthly_contribution)} />
          </div>
        </section>
      )}

      <section style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <button className="btn" disabled={!!busy} onClick={() => void run("株価更新 (stooq)", "/v1/portfolio/valuations/refresh")}>
          {busy === "株価更新 (stooq)" ? "取得中…" : "個別株/ETF の株価更新"}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void run("配当サジェスト", "/v1/portfolio/dividends/suggest")}>
          {busy === "配当サジェスト" ? "取得中…" : "保有銘柄の配当を取得"}
        </button>
      </section>
      {msg && <p style={{ color: "var(--ok)", fontSize: "0.8rem" }}>{msg}</p>}
      {err && <p className="error">{err}</p>}

      {/* 保有商品 */}
      <h3 style={{ marginTop: "1rem" }}>保有商品 ({summary?.holdings.length ?? 0})</h3>
      <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
        {summary?.holdings.map((s) => (
          <HoldingCard
            key={s.holding.id}
            s={s}
            expanded={expanded === s.holding.id}
            onToggle={() => setExpanded(expanded === s.holding.id ? null : s.holding.id)}
            onChanged={() => void load()}
          />
        ))}
      </div>

      <NewHoldingForm onCreated={() => void load()} />

      {/* 将来見通し */}
      {projection && (
        <section style={{ marginTop: "1.5rem" }}>
          <h3>将来見通し
            <select value={years} onChange={(e) => setYears(Number(e.target.value))} style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
              {[5, 10, 20, 30].map((y) => <option key={y} value={y}>{y}年後</option>)}
            </select>
          </h3>
          <p style={{ color: "var(--muted)", fontSize: "0.78rem", marginTop: "-0.3rem" }}>
            現在の評価額 + 毎月の積立を、 想定年率 保守 {projection.rates.conservative}% / 中立 {projection.rates.base}% / 楽観 {projection.rates.optimistic}% で投影 (決定論)。
          </p>
          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
            <Stat label={`保守 (${projection.rates.conservative}%)`} value={yen(projection.terminal.conservative)} />
            <Stat label={`中立 (${projection.rates.base}%)`} value={yen(projection.terminal.base)} accent="ok" />
            <Stat label={`楽観 (${projection.rates.optimistic}%)`} value={yen(projection.terminal.optimistic)} />
          </div>
          <Sparkline points={projection.base.map((p) => p.value)} />
        </section>
      )}

      {/* 配当株サジェスト */}
      <section style={{ marginTop: "1.5rem" }}>
        <h3>配当株サジェスト ({candidates.length})</h3>
        <p style={{ color: "var(--muted)", fontSize: "0.72rem", marginTop: "-0.3rem" }}>
          ⚠ 公開済 IR・有価証券報告書・過去実績などの一般情報のみ。 未公表の重要事実 (インサイダー情報) は扱いません。
          これは情報提示であり投資助言ではありません。 最新は各社 IR で要確認。
        </p>
        <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {candidates.map((c) => (
            <div key={c.ticker} className="last-capture" style={{ padding: "0.7rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>{c.company_name ?? c.ticker}</strong>
                <code style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{c.ticker}</code>
              </div>
              <div style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>
                配当利回り <strong>{pct(c.dividend_yield_pct)}</strong>
                {c.close != null && <span style={{ color: "var(--muted)" }}> ・ 株価 {yen(c.close)}</span>}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 2 }}>
                {c.dps_annual != null && `1株配当 ¥${c.dps_annual} ・ `}
                配当性向 {pct(c.payout_ratio_pct)}
                {c.consecutive_increase_years != null && ` ・ 連続増配 ${c.consecutive_increase_years}年`}
              </div>
              {c.rationale && <div style={{ fontSize: "0.78rem", marginTop: "0.35rem" }}>{c.rationale}</div>}
              {c.stability_note && <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: 2 }}>{c.stability_note}</div>}
            </div>
          ))}
          {candidates.length === 0 && (
            <p style={{ color: "var(--muted)" }}>まだ無し。 個別株/ETF を登録して「保有銘柄の配当を取得」を実行してください。</p>
          )}
        </div>
      </section>
    </div>
  );
}

// ── 小物 ──

function Stat({ label, value, accent }: { label: string; value: string; accent?: "ok" | "bad" }) {
  const color = accent === "ok" ? "var(--ok)" : accent === "bad" ? "#e2536b" : undefined;
  return (
    <div>
      <div style={{ color: "var(--muted)", fontSize: "0.7rem" }}>{label}</div>
      <div style={{ fontSize: "1.05rem", fontFamily: "monospace", color }}>{value}</div>
    </div>
  );
}

/** base シナリオの粗いライン (依存無しの inline SVG)。 */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 480, h = 90, pad = 4;
  const max = Math.max(...points), min = Math.min(...points);
  const span = max - min || 1;
  const d = points
    .map((v, i) => {
      const x = pad + (i / (points.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ marginTop: "0.5rem", maxWidth: w }}>
      <path d={d} fill="none" stroke="var(--ok)" strokeWidth={2} />
    </svg>
  );
}

function HoldingCard({ s, expanded, onToggle, onChanged }: {
  s: HoldingSummary; expanded: boolean; onToggle: () => void; onChanged: () => void;
}) {
  const h = s.holding;
  const r = s.ret;
  async function del() {
    if (!confirm(`${h.name} を削除しますか？ (拠出/時価/配当も消えます)`)) return;
    await fetch(`/v1/portfolio/holdings/${h.id}`, { method: "DELETE" });
    onChanged();
  }
  return (
    <div className="last-capture" style={{ padding: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{h.name}</strong>
        <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
          {KIND_LABEL[h.kind]}{h.tax_wrapper ? ` ・ ${WRAPPER_LABEL[h.tax_wrapper]}` : ""}{h.ticker ? ` ・ ${h.ticker}` : ""}
        </span>
      </div>
      {h.account && <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{h.account}</div>}

      <div style={{ display: "grid", gap: "0.4rem", gridTemplateColumns: "1fr 1fr", marginTop: "0.5rem", fontSize: "0.82rem" }}>
        <KV k="取得原価" v={yen(r.invested)} />
        <KV k="評価額" v={yen(r.market_value)} />
        <KV k="含み損益" v={yen(r.unrealized_pl)} accent={(r.unrealized_pl ?? 0) >= 0 ? "ok" : "bad"} />
        <KV k="利回り" v={pct(r.simple_return_pct)} accent={(r.simple_return_pct ?? 0) >= 0 ? "ok" : "bad"} />
        <KV k="年率(XIRR)" v={pct(r.annualized_xirr_pct)} />
        <KV k="計画比" v={r.variance == null ? "—" : yen(r.variance)} accent={(r.variance ?? 0) >= 0 ? "ok" : "bad"} />
      </div>
      {h.target_amount != null && (
        <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: "0.3rem" }}>
          目標 {yen(h.target_amount)}{h.monthly_contribution ? ` ・ 計画積立 ${yen(h.monthly_contribution)}/月` : ""}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}>
        <button className="btn" style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }} onClick={onToggle}>
          {expanded ? "閉じる" : "記録を追加"}
        </button>
        <button className="btn" style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }} onClick={() => void del()}>削除</button>
      </div>

      {expanded && <HoldingEditor holdingId={h.id} onChanged={onChanged} />}
    </div>
  );
}

function KV({ k, v, accent }: { k: string; v: string; accent?: "ok" | "bad" }) {
  const color = accent === "ok" ? "var(--ok)" : accent === "bad" ? "#e2536b" : undefined;
  return (
    <div>
      <span style={{ color: "var(--muted)", fontSize: "0.7rem" }}>{k} </span>
      <span style={{ fontFamily: "monospace", color }}>{v}</span>
    </div>
  );
}

/** 拠出 / 時価 / 配当の追加フォーム (1 holding 用)。 */
function HoldingEditor({ holdingId, onChanged }: { holdingId: string; onChanged: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [cDate, setCDate] = useState(today);
  const [cAmount, setCAmount] = useState("");
  const [cKind, setCKind] = useState<"actual" | "planned">("actual");
  const [cUnits, setCUnits] = useState("");
  const [vDate, setVDate] = useState(today);
  const [vValue, setVValue] = useState("");
  const [dDate, setDDate] = useState(today);
  const [dAmount, setDAmount] = useState("");

  async function postTo(path: string, body: Record<string, unknown>) {
    const res = await fetch(`/v1/portfolio/holdings/${holdingId}/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.ok) onChanged();
  }

  return (
    <div style={{ marginTop: "0.6rem", borderTop: "1px solid var(--border)", paddingTop: "0.5rem", display: "grid", gap: "0.5rem" }}>
      <Row label="拠出">
        <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} />
        <input type="number" placeholder="円" value={cAmount} onChange={(e) => setCAmount(e.target.value)} style={{ width: 90 }} />
        <select value={cKind} onChange={(e) => setCKind(e.target.value as "actual" | "planned")}>
          <option value="actual">実績</option>
          <option value="planned">計画</option>
        </select>
        <input type="number" placeholder="口数(任意)" value={cUnits} onChange={(e) => setCUnits(e.target.value)} style={{ width: 90 }} />
        <button className="btn" style={btn} disabled={!cAmount} onClick={() => void postTo("contributions", {
          date: cDate, amount: Number(cAmount), kind: cKind, units: cUnits ? Number(cUnits) : undefined,
        }).then(() => { setCAmount(""); setCUnits(""); })}>追加</button>
      </Row>
      <Row label="時価">
        <input type="date" value={vDate} onChange={(e) => setVDate(e.target.value)} />
        <input type="number" placeholder="評価額(円)" value={vValue} onChange={(e) => setVValue(e.target.value)} style={{ width: 110 }} />
        <button className="btn" style={btn} disabled={!vValue} onClick={() => void postTo("valuations", {
          as_of: vDate, market_value: Number(vValue),
        }).then(() => setVValue(""))}>記録</button>
      </Row>
      <Row label="配当">
        <input type="date" value={dDate} onChange={(e) => setDDate(e.target.value)} />
        <input type="number" placeholder="受取額(円)" value={dAmount} onChange={(e) => setDAmount(e.target.value)} style={{ width: 110 }} />
        <button className="btn" style={btn} disabled={!dAmount} onClick={() => void postTo("dividends", {
          pay_date: dDate, amount: Number(dAmount),
        }).then(() => setDAmount(""))}>追加</button>
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap", fontSize: "0.78rem" }}>
      <span style={{ width: 36, color: "var(--muted)" }}>{label}</span>
      {children}
    </div>
  );
}

const btn = { fontSize: "0.75rem", padding: "0.2rem 0.55rem" };

function NewHoldingForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<HoldingKind>("fund");
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [ticker, setTicker] = useState("");
  const [wrapper, setWrapper] = useState<TaxWrapper | "">("nisa_tsumitate");
  const [monthly, setMonthly] = useState("");
  const [target, setTarget] = useState("");
  const [started, setStarted] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setErr(null);
    const body: Record<string, unknown> = { kind, name };
    if (account) body.account = account;
    if (ticker) body.ticker = ticker;
    if (wrapper) body.tax_wrapper = wrapper;
    if (monthly) body.monthly_contribution = Number(monthly);
    if (target) body.target_amount = Number(target);
    if (started) body.started_at = started;
    const res = await fetch("/v1/portfolio/holdings", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json() as { error?: string };
    if (!res.ok) { setErr(j.error ?? `${res.status}`); return; }
    setName(""); setAccount(""); setTicker(""); setMonthly(""); setTarget(""); setStarted("");
    setOpen(false);
    onCreated();
  }

  if (!open) {
    return <button className="btn" style={{ marginTop: "0.75rem" }} onClick={() => setOpen(true)}>＋ 商品を追加</button>;
  }
  return (
    <section className="last-capture" style={{ padding: "0.75rem", marginTop: "0.75rem", display: "grid", gap: "0.5rem", maxWidth: 560 }}>
      <strong style={{ fontSize: "0.9rem" }}>商品を追加</strong>
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", fontSize: "0.82rem", alignItems: "center" }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as HoldingKind)}>
          {(Object.keys(KIND_LABEL) as HoldingKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <input placeholder="商品名" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
      </div>
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", fontSize: "0.82rem" }}>
        <input placeholder="口座/契約先" value={account} onChange={(e) => setAccount(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        {(kind === "stock" || kind === "etf") && (
          <input placeholder="証券コード(4桁)" value={ticker} onChange={(e) => setTicker(e.target.value)} style={{ width: 120 }} />
        )}
        <select value={wrapper} onChange={(e) => setWrapper(e.target.value as TaxWrapper | "")}>
          <option value="">(口座種別なし)</option>
          {(Object.keys(WRAPPER_LABEL) as TaxWrapper[]).map((w) => <option key={w} value={w}>{WRAPPER_LABEL[w]}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", fontSize: "0.82rem", alignItems: "center" }}>
        <label>積立 <input type="number" placeholder="円/月" value={monthly} onChange={(e) => setMonthly(e.target.value)} style={{ width: 100 }} /></label>
        <label>目標 <input type="number" placeholder="円" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 110 }} /></label>
        <label>開始 <input type="date" value={started} onChange={(e) => setStarted(e.target.value)} /></label>
      </div>
      {err && <p className="error" style={{ margin: 0 }}>{err}</p>}
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <button className="btn" disabled={!name} onClick={() => void create()}>作成</button>
        <button className="btn" onClick={() => setOpen(false)}>キャンセル</button>
      </div>
    </section>
  );
}
