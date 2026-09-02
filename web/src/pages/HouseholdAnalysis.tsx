import { useEffect, useState } from "react";

/** 家計分析ページ: 週 / 月 / 3ヶ月 / 6ヶ月 / 1年 で費目別・場所別・地点別・決済手段別・日別を見る。 API は /v1/household/analysis。
 * @implements SPEC-HOUSEHOLD-ANALYSIS-002 (spec/feature/household-bookkeeping.md) */

type Window = "week" | "month" | "quarter" | "half" | "year";
const WINDOWS: { key: Window; label: string }[] = [
  { key: "week", label: "週" }, { key: "month", label: "月" }, { key: "quarter", label: "3ヶ月" }, { key: "half", label: "6ヶ月" }, { key: "year", label: "1年" },
];

interface Totals { spend: number; household: number; business: number; count: number }
interface AnalysisRes {
  window: { window: Window; anchor: string; current: { from: string; to: string }; previous: { from: string; to: string }; label: string };
  coverage: { latest: string | null; earliest: string | null; months: string[] };
  totals: { current: Totals; previous: Totals; delta: number };
  by_category: { category_id: number; name: string; current: number; previous: number; delta: number; share: number; count: number }[];
  by_place: { payee_norm: string; payee_sample: string; amount: number; count: number; household: number; business: number; previous: number; category_name: string; receipt_linked: number }[];
  by_location: { lat: number; lon: number; amount: number; count: number; payees: string[] }[];
  by_method: { method: string; amount: number; count: number }[];
  daily: { date: string; amount: number }[];
  receipt_link: { events: number; with_receipt: number; rate: number };
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const signed = (n: number) => (n > 0 ? `+${yen(n)}` : n < 0 ? `-${yen(-n)}` : "±0");
const today = () => new Date().toISOString().slice(0, 10);

export function HouseholdAnalysis() {
  const [window, setWindow] = useState<Window>("month");
  const [anchor, setAnchor] = useState(today());
  const [data, setData] = useState<AnalysisRes | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ window, anchor });
    fetch(`/v1/household/analysis?${params}`)
      .then(async (r) => { const j = await r.json() as AnalysisRes & { error?: string }; if (!r.ok) throw new Error(j.error ?? String(r.status)); return j; })
      .then((j) => { setData(j); setErr(null); })
      .catch((e: Error) => setErr(e.message));
  }, [window, anchor]);

  const maxDaily = data ? Math.max(...data.daily.map((d) => d.amount), 1) : 1;
  const maxCat = data ? Math.max(...data.by_category.map((c) => Math.max(c.current, c.previous)), 1) : 1;
  const latestMonth = data?.coverage.latest;
  const stale = latestMonth && data && data.window.current.to.slice(0, 7) > latestMonth;

  return (
    <div>
      <h2>家計分析</h2>
      <div className="foundation-form" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {WINDOWS.map((w) => <button key={w.key} aria-current={window === w.key} onClick={() => setWindow(w.key)}>{w.label}</button>)}
        <label>基準日 <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} /></label>
      </div>
      {err && <p className="error">{err}</p>}
      {data && (
        <>
          <p>
            期間 <b>{data.window.label}</b> ({data.window.current.from} 〜 {data.window.current.to}) / 比較 {data.window.previous.from} 〜 {data.window.previous.to}
            {stale && <span className="error"> ※ データのある最終月は {latestMonth}。 クレカ明細は 1 ヶ月遅れで入るため最新月は未取込の可能性</span>}
          </p>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            <table>
              <thead><tr><th></th><th>今期</th><th>前期</th><th>差分</th></tr></thead>
              <tbody>
                <tr><td>支出合計</td><td style={{ textAlign: "right" }}><b>{yen(data.totals.current.spend)}</b></td><td style={{ textAlign: "right" }}>{yen(data.totals.previous.spend)}</td><td style={{ textAlign: "right" }}>{signed(data.totals.delta)}</td></tr>
                <tr><td>うち家計</td><td style={{ textAlign: "right" }}>{yen(data.totals.current.household)}</td><td style={{ textAlign: "right" }}>{yen(data.totals.previous.household)}</td><td style={{ textAlign: "right" }}>{signed(data.totals.current.household - data.totals.previous.household)}</td></tr>
                <tr><td>うち事業経費</td><td style={{ textAlign: "right" }}>{yen(data.totals.current.business)}</td><td style={{ textAlign: "right" }}>{yen(data.totals.previous.business)}</td><td style={{ textAlign: "right" }}>{signed(data.totals.current.business - data.totals.previous.business)}</td></tr>
                <tr><td>件数</td><td style={{ textAlign: "right" }}>{data.totals.current.count}</td><td style={{ textAlign: "right" }}>{data.totals.previous.count}</td><td></td></tr>
                <tr><td>レシート紐づき</td><td style={{ textAlign: "right" }}>{data.receipt_link.with_receipt} / {data.receipt_link.events} ({pct(data.receipt_link.rate)})</td><td></td><td></td></tr>
              </tbody>
            </table>
            <div>
              <h3>決済手段別</h3>
              <table><tbody>{data.by_method.map((m) => <tr key={m.method}><td>{m.method}</td><td style={{ textAlign: "right" }}>{yen(m.amount)}</td><td style={{ textAlign: "right" }}>{m.count} 件</td></tr>)}</tbody></table>
            </div>
          </div>

          <h3>費目別 (前期比)</h3>
          <table style={{ width: "100%" }}>
            <thead><tr><th>費目</th><th>今期</th><th>前期</th><th>差分</th><th>割合</th><th style={{ width: "40%" }}></th></tr></thead>
            <tbody>{data.by_category.map((c) => (
              <tr key={c.category_id}>
                <td>{c.name}</td><td style={{ textAlign: "right" }}>{yen(c.current)}</td><td style={{ textAlign: "right" }}>{yen(c.previous)}</td>
                <td style={{ textAlign: "right", color: c.delta > 0 ? "#b00" : "#080" }}>{signed(c.delta)}</td><td style={{ textAlign: "right" }}>{pct(c.share)}</td>
                <td>
                  <div style={{ background: "#4a7", height: 8, width: `${(c.current / maxCat) * 100}%` }} />
                  <div style={{ background: "#bbb", height: 4, width: `${(c.previous / maxCat) * 100}%`, marginTop: 2 }} />
                </td>
              </tr>
            ))}</tbody>
          </table>

          <h3>日別推移</h3>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 120, overflowX: "auto" }}>
            {data.daily.map((d) => (
              <div key={d.date} title={`${d.date} ${yen(d.amount)}`} style={{ flex: "1 0 4px", minWidth: 4, background: "#58a", height: `${(d.amount / maxDaily) * 100}%` }} />
            ))}
          </div>

          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            <div>
              <h3>場所別 (店)</h3>
              <table>
                <thead><tr><th>店</th><th>費目</th><th>金額</th><th>件数</th><th>前期</th><th>事業分</th><th>レシート</th></tr></thead>
                <tbody>{data.by_place.map((p) => (
                  <tr key={p.payee_norm}>
                    <td>{p.payee_sample}</td><td>{p.category_name}</td><td style={{ textAlign: "right" }}>{yen(p.amount)}</td><td style={{ textAlign: "right" }}>{p.count}</td>
                    <td style={{ textAlign: "right" }}>{yen(p.previous)}</td><td style={{ textAlign: "right" }}>{p.business ? yen(p.business) : ""}</td><td style={{ textAlign: "right" }}>{p.receipt_linked}/{p.count}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div>
              <h3>地点別 (レシート GPS、 約 100 m 格子)</h3>
              {data.by_location.length === 0 ? <p>位置情報付きレシートがありません</p> : (
                <table>
                  <thead><tr><th>地点</th><th>金額</th><th>件数</th><th>主な店</th></tr></thead>
                  <tbody>{data.by_location.map((l) => (
                    <tr key={`${l.lat},${l.lon}`}>
                      <td><a href={`https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}`} target="_blank" rel="noreferrer">{l.lat}, {l.lon}</a></td>
                      <td style={{ textAlign: "right" }}>{yen(l.amount)}</td><td style={{ textAlign: "right" }}>{l.count}</td><td>{l.payees.join(" / ")}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
