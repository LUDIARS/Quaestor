import { useCallback, useEffect, useState } from "react";

/** 固定費・変動費ビュー + 水道光熱費スキャン + 固定費候補 + 分類ルール。 API は /v1/cost-structure。
 * @implements SPEC-COST-STRUCTURE-004 (spec/feature/cost-structure.md) */

type Window = "week" | "month" | "quarter" | "half" | "year";
const WINDOWS: { key: Window; label: string }[] = [
  { key: "month", label: "月" }, { key: "quarter", label: "3ヶ月" }, { key: "half", label: "6ヶ月" }, { key: "year", label: "1年" },
];
type CostType = "fixed" | "variable";
type Utility = "electric" | "gas" | "water";

interface PayeeRow { payee_norm: string; payee_sample: string; cost_type: CostType; utility: Utility | null; label: string | null; rule_id: number | null; amount: number; count: number; business: number; previous: number; monthly: { month: string; amount: number }[] }
interface Totals { amount: number; count: number; business: number; previous: number; share: number }
interface View { window: { label: string; current: { from: string; to: string }; previous: { from: string; to: string } }; totals: { fixed: Totals; variable: Totals; spend: number; previous_spend: number }; fixed: PayeeRow[]; variable: PayeeRow[]; months: string[]; events: number; journal_months_used: string[] }
interface UtilMonth { month: string; by_kind: Record<Utility, number>; total: number }
interface UtilKind { kind: Utility; label: string; latest_month: string | null; latest_amount: number; previous_year_amount: number | null; yoy_delta: number | null; average_12m: number; total_12m: number; payees: string[] }
interface UtilScan { months: UtilMonth[]; kinds: UtilKind[]; total_12m: number; events: number }
interface Suggestion { payee_norm: string; payee_sample: string; months_present: number; months_window: number; average: number; cv: number; monthly: { month: string; amount: number }[] }
interface Rule { id: number; pattern: string; cost_type: CostType; utility: Utility | null; label: string | null; priority: number; enabled: number; note: string | null }

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const signed = (n: number) => (n > 0 ? `+${yen(n)}` : n < 0 ? `-${yen(-n)}` : "±0");
const today = () => new Date().toISOString().slice(0, 10);
const UTIL_COLOR: Record<Utility, string> = { electric: "#f6c344", gas: "#f08a5d", water: "#5aa9e6" };

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json() as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

function Spark({ series, max }: { series: { month: string; amount: number }[]; max: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 1, height: 18 }}>
      {series.map((p) => <span key={p.month} title={`${p.month} ${yen(p.amount)}`} style={{ width: 5, background: "#58a", height: `${max > 0 ? Math.max(2, (p.amount / max) * 100) : 2}%` }} />)}
    </span>
  );
}

function PayeeTable({ rows, months }: { rows: PayeeRow[]; months: string[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.monthly.map((m) => m.amount)));
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%" }}>
        <thead><tr><th>店 / サービス</th><th>区分</th><th>金額</th><th>件数</th><th>前期</th><th>事業分</th>{months.length > 1 && <th>推移</th>}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.payee_norm}>
            <td>{r.payee_sample}</td><td>{r.label ?? (r.rule_id === null ? <span className="text-subtle">未分類</span> : "")}</td>
            <td style={{ textAlign: "right" }}>{yen(r.amount)}</td><td style={{ textAlign: "right" }}>{r.count}</td>
            <td style={{ textAlign: "right" }}>{yen(r.previous)}</td><td style={{ textAlign: "right" }}>{r.business ? yen(r.business) : ""}</td>
            {months.length > 1 && <td><Spark series={r.monthly} max={max} /></td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function CostStructure() {
  const [window, setWindow] = useState<Window>("month");
  const [anchor, setAnchor] = useState(today());
  const [view, setView] = useState<View | null>(null);
  const [util, setUtil] = useState<UtilScan | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ruleForm, setRuleForm] = useState({ pattern: "", cost_type: "fixed" as CostType, utility: "" as "" | Utility, label: "" });
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ window, anchor });
      setView(await jsonFetch<View>(`/v1/cost-structure?${q}`));
      setUtil(await jsonFetch<UtilScan>(`/v1/cost-structure/utilities?anchor=${anchor}&months=12`));
      setSuggestions((await jsonFetch<{ items: Suggestion[] }>(`/v1/cost-structure/suggestions?anchor=${anchor}&months=6`)).items);
      setRules((await jsonFetch<{ items: Rule[] }>("/v1/cost-structure/rules?include_disabled=1")).items);
      setErr(null);
    } catch (e: unknown) { setErr((e as Error).message); }
  }, [window, anchor]);
  useEffect(() => { void load(); }, [load]);

  async function applySuggestions(payees: string[]) {
    try {
      const r = await jsonFetch<{ created: number; reactivated: number; skipped: string[] }>("/v1/cost-structure/suggestions/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payees, cost_type: "fixed" }) });
      setNotice(`固定費ルールを ${r.created} 件作成${r.reactivated ? `、${r.reactivated} 件再有効化` : ""}${r.skipped.length ? ` (既存 ${r.skipped.length})` : ""}`);
      setSelected(new Set());
      await load();
    } catch (e: unknown) { setErr((e as Error).message); }
  }
  async function addRule() {
    try {
      await jsonFetch("/v1/cost-structure/rules", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: ruleForm.pattern, cost_type: ruleForm.cost_type, utility: ruleForm.utility || null, label: ruleForm.label || null }) });
      setRuleForm({ ...ruleForm, pattern: "", label: "" });
      await load();
    } catch (e: unknown) { setErr((e as Error).message); }
  }
  async function toggleRule(r: Rule) {
    try { await jsonFetch(`/v1/cost-structure/rules/${r.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !r.enabled }) }); await load(); }
    catch (e: unknown) { setErr((e as Error).message); }
  }
  async function flipRule(r: Rule) {
    try { await jsonFetch(`/v1/cost-structure/rules/${r.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cost_type: r.cost_type === "fixed" ? "variable" : "fixed" }) }); await load(); }
    catch (e: unknown) { setErr((e as Error).message); }
  }
  async function removeRule(id: number) {
    try { await jsonFetch(`/v1/cost-structure/rules/${id}`, { method: "DELETE" }); await load(); }
    catch (e: unknown) { setErr((e as Error).message); }
  }

  const utilMax = util ? Math.max(1, ...util.months.map((m) => m.total)) : 1;

  return (
    <div>
      <h2>固定費・変動費</h2>
      <div className="foundation-form" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {WINDOWS.map((w) => <button key={w.key} aria-current={window === w.key} onClick={() => setWindow(w.key)}>{w.label}</button>)}
        <label>基準日 <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} /></label>
      </div>
      {notice && <p>{notice}</p>}
      {err && <p className="error">{err}</p>}

      <h3>水道光熱費 (直近 12 ヶ月)</h3>
      {util && (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
          <div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 140 }}>
              {util.months.map((m) => (
                <div key={m.month} title={`${m.month} 電気 ${yen(m.by_kind.electric)} / ガス ${yen(m.by_kind.gas)} / 水道 ${yen(m.by_kind.water)}`} style={{ flex: 1, display: "flex", flexDirection: "column-reverse", height: "100%" }}>
                  {(["electric", "gas", "water"] as Utility[]).map((k) => <div key={k} style={{ background: UTIL_COLOR[k], height: `${(m.by_kind[k] / utilMax) * 100}%` }} />)}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 3, fontSize: 10 }} className="text-subtle">{util.months.map((m) => <span key={m.month} style={{ flex: 1, textAlign: "center" }}>{m.month.slice(5)}</span>)}</div>
            <p className="text-subtle text-xs">検出 {util.events} 件 / 12 ヶ月合計 {yen(util.total_12m)}</p>
          </div>
          <table>
            <thead><tr><th>種別</th><th>最新月</th><th>金額</th><th>前年同月</th><th>差</th><th>月平均</th><th>支払先</th></tr></thead>
            <tbody>{util.kinds.map((k) => (
              <tr key={k.kind}>
                <td><span style={{ display: "inline-block", width: 10, height: 10, background: UTIL_COLOR[k.kind], marginRight: 6 }} />{k.label}</td>
                <td>{k.latest_month ?? "-"}</td><td style={{ textAlign: "right" }}>{yen(k.latest_amount)}</td>
                <td style={{ textAlign: "right" }}>{k.previous_year_amount === null ? "-" : yen(k.previous_year_amount)}</td>
                <td style={{ textAlign: "right", color: (k.yoy_delta ?? 0) > 0 ? "#b00" : "#080" }}>{k.yoy_delta === null ? "-" : signed(k.yoy_delta)}</td>
                <td style={{ textAlign: "right" }}>{yen(k.average_12m)}</td><td className="text-xs text-subtle">{k.payees.join(" / ") || "未検出"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {view && (
        <>
          <h3>固定費 / 変動費 ({view.window.label})</h3>
          {view.journal_months_used.length > 0 && <p className="text-subtle text-xs">取引の無い月 ({view.journal_months_used.join(", ")}) は取込済み仕訳から補っています</p>}
          <table>
            <thead><tr><th></th><th>今期</th><th>割合</th><th>前期</th><th>差</th><th>事業分</th><th>件数</th></tr></thead>
            <tbody>
              {(["fixed", "variable"] as CostType[]).map((t) => {
                const x = view.totals[t];
                return (
                  <tr key={t}><td><b>{t === "fixed" ? "固定費" : "変動費"}</b></td><td style={{ textAlign: "right" }}><b>{yen(x.amount)}</b></td><td style={{ textAlign: "right" }}>{pct(x.share)}</td>
                    <td style={{ textAlign: "right" }}>{yen(x.previous)}</td><td style={{ textAlign: "right" }}>{signed(x.amount - x.previous)}</td><td style={{ textAlign: "right" }}>{yen(x.business)}</td><td style={{ textAlign: "right" }}>{x.count}</td></tr>
                );
              })}
              <tr><td>合計</td><td style={{ textAlign: "right" }}>{yen(view.totals.spend)}</td><td></td><td style={{ textAlign: "right" }}>{yen(view.totals.previous_spend)}</td><td style={{ textAlign: "right" }}>{signed(view.totals.spend - view.totals.previous_spend)}</td><td></td><td style={{ textAlign: "right" }}>{view.events}</td></tr>
            </tbody>
          </table>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            <div><h4>固定費 ({view.fixed.length})</h4><PayeeTable rows={view.fixed} months={view.months} /></div>
            <div><h4>変動費 ({view.variable.length})</h4><PayeeTable rows={view.variable.slice(0, 60)} months={view.months} /></div>
          </div>
        </>
      )}

      <h3>固定費の候補 (直近 6 ヶ月で毎月ほぼ同額)</h3>
      {suggestions.length === 0 ? <p className="text-subtle">候補はありません</p> : (
        <div>
          <div className="foundation-form" style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setSelected(new Set(suggestions.map((s) => s.payee_norm)))}>全選択</button>
            <button disabled={selected.size === 0} onClick={() => void applySuggestions([...selected])}>選択を固定費にする ({selected.size})</button>
          </div>
          <table>
            <thead><tr><th></th><th>店 / サービス</th><th>出現</th><th>月平均</th><th>ばらつき</th><th>推移</th></tr></thead>
            <tbody>{suggestions.map((s) => (
              <tr key={s.payee_norm}>
                <td><input type="checkbox" checked={selected.has(s.payee_norm)} onChange={() => setSelected((cur) => { const n = new Set(cur); if (n.has(s.payee_norm)) n.delete(s.payee_norm); else n.add(s.payee_norm); return n; })} /></td>
                <td>{s.payee_sample}</td><td>{s.months_present}/{s.months_window} 月</td><td style={{ textAlign: "right" }}>{yen(s.average)}</td><td>{pct(s.cv)}</td>
                <td><Spark series={s.monthly} max={Math.max(1, ...s.monthly.map((m) => m.amount))} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      <details style={{ marginTop: 16 }}>
        <summary>分類ルール ({rules.length})</summary>
        <div className="foundation-form" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input placeholder="pattern (正規表現)" value={ruleForm.pattern} onChange={(e) => setRuleForm({ ...ruleForm, pattern: e.target.value })} />
          <select value={ruleForm.cost_type} onChange={(e) => setRuleForm({ ...ruleForm, cost_type: e.target.value as CostType })}><option value="fixed">固定費</option><option value="variable">変動費</option></select>
          <select value={ruleForm.utility} onChange={(e) => setRuleForm({ ...ruleForm, utility: e.target.value as "" | Utility })}><option value="">光熱費でない</option><option value="electric">電気</option><option value="gas">ガス</option><option value="water">水道</option></select>
          <input placeholder="ラベル" value={ruleForm.label} onChange={(e) => setRuleForm({ ...ruleForm, label: e.target.value })} />
          <button onClick={() => void addRule()} disabled={!ruleForm.pattern}>追加</button>
        </div>
        <table>
          <thead><tr><th>優先</th><th>pattern</th><th>区分</th><th>光熱</th><th>ラベル</th><th>有効</th><th></th></tr></thead>
          <tbody>{rules.map((r) => (
            <tr key={r.id}><td>{r.priority}</td><td><code>{r.pattern.length > 60 ? `${r.pattern.slice(0, 60)}…` : r.pattern}</code></td>
              <td><button onClick={() => void flipRule(r)}>{r.cost_type === "fixed" ? "固定費" : "変動費"} ⇄</button></td><td>{r.utility ?? ""}</td><td>{r.label ?? ""}</td>
              <td><input type="checkbox" checked={!!r.enabled} onChange={() => void toggleRule(r)} /></td><td><button onClick={() => void removeRule(r.id)}>削除</button></td></tr>
          ))}</tbody>
        </table>
      </details>
    </div>
  );
}
