import { useEffect, useState } from "react";

/**
 * 投資 / 優待アドバイザ。
 * よく使う店 → 運営企業の株価動向・株主優待を提示する。
 * 重い処理 (Claude マッピング / stooq 株価 / 優待取得) は明示ボタンで実行する。
 */

interface Suggestion {
  payees: string[];
  visits: number;
  total_spend: number;
  ticker: string;
  company_name: string | null;
  market: string | null;
  relation: string;
  confidence: number;
  close: number | null;
  change_pct: number | null;
  period_days: number | null;
  as_of: string | null;
  has_perk: boolean;
  min_shares: number | null;
  perk_description: string | null;
  ex_rights_months: number[];
  perk_value_yen: number | null;
  perk_yield_pct: number | null;
  required_investment: number | null;
}

interface BehaviorEntry {
  payee_norm: string;
  payee_sample: string;
  visits: number;
  total_spend: number;
  sources: string[];
}

const RELATION_LABEL: Record<string, string> = {
  operator: "運営会社",
  brand: "ブランド保有",
  parent: "親会社",
  none: "該当なし",
};

export function Invest() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [behavior, setBehavior] = useState<BehaviorEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [sg, bh] = await Promise.all([
        fetch("/v1/invest/suggestions").then((r) => r.json() as Promise<{ items: Suggestion[] }>),
        fetch("/v1/invest/behavior?limit=30").then((r) => r.json() as Promise<{ items: BehaviorEntry[] }>),
      ]);
      setSuggestions(sg.items);
      setBehavior(bh.items);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function run(label: string, path: string, body: unknown = {}) {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
  const mappedTickers = new Set(suggestions.map((s) => s.ticker));
  const unmapped = behavior.filter((b) => !suggestions.some((s) => s.payees.includes(b.payee_sample)));

  return (
    <div>
      <h2>投資 / 優待アドバイザ</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: "-0.4rem" }}>
        よく使う店の運営企業を株主目線で。 まず「① 銘柄マッピング」→「② 株価更新」→「③ 優待更新」を順に実行。
      </p>

      <section style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <button className="btn" disabled={!!busy} onClick={() => void run("① 銘柄マッピング", "/v1/invest/map", { limit: 30 })}>
          {busy === "① 銘柄マッピング" ? "解析中…" : "① 銘柄マッピング"}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void run("② 株価更新", "/v1/invest/quotes/refresh", { period_days: 90 })}>
          {busy === "② 株価更新" ? "取得中…" : "② 株価更新"}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void run("③ 優待更新", "/v1/invest/perks/refresh")}>
          {busy === "③ 優待更新" ? "取得中…" : "③ 優待更新"}
        </button>
      </section>

      {msg && <p style={{ color: "var(--ok)", fontSize: "0.8rem" }}>{msg}</p>}
      {err && <p className="error">{err}</p>}

      <h3 style={{ marginTop: "1rem" }}>提案 ({suggestions.length} 銘柄)</h3>
      {suggestions.length === 0 && (
        <p style={{ color: "var(--muted)" }}>まだ無し。 上のボタンでマッピングを実行してください。</p>
      )}
      <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        {suggestions.map((s) => (
          <div key={s.ticker} className="last-capture" style={{ padding: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong>{s.company_name ?? s.ticker}</strong>
              <code style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{s.ticker}</code>
            </div>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginBottom: "0.4rem" }}>
              {s.market ?? "-"} ・ {RELATION_LABEL[s.relation] ?? s.relation}
              {s.confidence > 0 && ` ・ 確度 ${Math.round(s.confidence * 100)}%`}
            </div>

            <div style={{ fontSize: "0.8rem", marginBottom: "0.4rem" }}>
              利用 {s.visits} 回 ・ 累計 ¥{s.total_spend.toLocaleString()}
            </div>

            <div style={{ display: "flex", gap: "1rem", fontSize: "0.85rem", marginBottom: "0.4rem" }}>
              <div>
                <div style={{ color: "var(--muted)", fontSize: "0.7rem" }}>株価{s.period_days ? ` (${s.period_days}日)` : ""}</div>
                {s.close != null ? (
                  <span style={{ fontFamily: "monospace" }}>
                    ¥{s.close.toLocaleString()}{" "}
                    {s.change_pct != null && (
                      <span style={{ color: s.change_pct >= 0 ? "var(--ok)" : "#e2536b" }}>
                        {s.change_pct >= 0 ? "▲" : "▼"}{Math.abs(s.change_pct)}%
                      </span>
                    )}
                  </span>
                ) : <span style={{ color: "var(--muted)" }}>未取得</span>}
              </div>
            </div>

            <div style={{ fontSize: "0.8rem", borderTop: "1px solid var(--border)", paddingTop: "0.4rem" }}>
              <div style={{ color: "var(--muted)", fontSize: "0.7rem" }}>株主優待</div>
              {s.has_perk ? (
                <>
                  <div>{s.perk_description ?? "(内容不明)"}</div>
                  <div style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: 2 }}>
                    {s.min_shares != null && `${s.min_shares} 株`}
                    {s.required_investment != null && ` (約 ¥${s.required_investment.toLocaleString()})`}
                    {s.ex_rights_months.length > 0 && ` ・ 権利 ${s.ex_rights_months.join("/")}月`}
                    {s.perk_yield_pct != null && ` ・ 優待利回り ${s.perk_yield_pct}%`}
                  </div>
                </>
              ) : <span style={{ color: "var(--muted)" }}>優待なし / 未取得</span>}
            </div>

            <div style={{ fontSize: "0.68rem", color: "var(--muted)", marginTop: "0.4rem" }}>
              対象店: {s.payees.slice(0, 3).join(", ")}{s.payees.length > 3 ? ` 他${s.payees.length - 3}` : ""}
            </div>
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: "1.5rem" }}>未マッピングの利用店 ({unmapped.length})</h3>
      <p style={{ color: "var(--muted)", fontSize: "0.78rem", marginTop: "-0.4rem" }}>
        マッピング済 {mappedTickers.size} 銘柄。 下記は上場該当なし or 未解析。
      </p>
      <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th style={{ textAlign: "left", padding: "0.3rem" }}>店名</th>
            <th style={{ textAlign: "right", padding: "0.3rem" }}>利用</th>
            <th style={{ textAlign: "right", padding: "0.3rem" }}>累計</th>
          </tr>
        </thead>
        <tbody>
          {unmapped.map((b) => (
            <tr key={b.payee_norm} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "0.3rem" }}>{b.payee_sample}</td>
              <td style={{ padding: "0.3rem", textAlign: "right" }}>{b.visits}</td>
              <td style={{ padding: "0.3rem", textAlign: "right" }}>¥{b.total_spend.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
