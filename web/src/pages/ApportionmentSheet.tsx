import { useCallback, useEffect, useState } from "react";
import { currentYear } from "../components/YearTabs.js";

/** 按分シート: 過去帳簿の観測から 店 → 按分率・科目 のルールを生成する。 家計費目ルールもここで編集する。
 * @implements SPEC-APPORTIONMENT-SHEET-002 (spec/feature/household-bookkeeping.md) */

type Status = "match" | "differs" | "proposal" | "unknown";
const STATUS_LABEL: Record<Status, string> = { proposal: "提案あり (ルール無し)", differs: "現行ルールと不一致", unknown: "判断待ち", match: "一致" };

interface SheetRow {
  payee_norm: string; payee_sample: string;
  observations: { rate: number; code: number; occurrences: number; total_amount: number; sources: string[]; last_seen: string | null }[];
  proposed: { rate: number; code: number; occurrences: number } | null;
  current: { rate: number; code: number; rule_id: number | null };
  status: Status; spend_in_year: number; tx_count_in_year: number;
}
interface SheetRes { year: number; observations: number; counts: Record<string, number>; rows: SheetRow[] }
interface Candidate { payee_norm: string; pattern: string; rate: number; code: number; priority: number; action: "create" | "update" | "skip"; reason: string; rule_id?: number }
interface SynthRes { dry_run: boolean; candidates: Candidate[]; created: number; updated: number }
interface AccountCode { code: number; name: string }
interface Category { id: number; name: string }
interface HouseholdRule { id: number; pattern: string; category_id: number; priority: number; enabled: number; note: string | null }

const yen = (n: number) => n.toLocaleString("ja-JP");

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json() as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

export function ApportionmentSheet() {
  const [year, setYear] = useState(Number(currentYear()));
  const [status, setStatus] = useState<Status | "">("");
  const [data, setData] = useState<SheetRes | null>(null);
  const [accounts, setAccounts] = useState<AccountCode[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [override, setOverride] = useState(false);
  const [preview, setPreview] = useState<SynthRes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ year: String(year) });
      if (status) q.set("status", status);
      setData(await jsonFetch<SheetRes>(`/v1/apportionment-sheet?${q}`));
      setErr(null);
    } catch (e: unknown) { setErr((e as Error).message); }
  }, [year, status]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void jsonFetch<{ items: AccountCode[] }>("/v1/account-codes").then((j) => setAccounts(j.items)).catch(() => undefined); }, []);

  const codeName = (c: number) => accounts.find((a) => a.code === c)?.name ?? "";

  async function collect() {
    try {
      const r = await jsonFetch<{ years: number[]; observations: number }>("/v1/apportionment-sheet/collect", { method: "POST" });
      setNotice(`帳簿から観測を再構築: ${r.observations} 件 (年度 ${r.years.join(", ")})`);
      await load();
    } catch (e: unknown) { setErr((e as Error).message); }
  }

  async function synthesize(dryRun: boolean) {
    try {
      const body = { year, dry_run: dryRun, override, payees: selected.size ? [...selected] : undefined };
      const r = await jsonFetch<SynthRes>("/v1/apportionment-sheet/synthesize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setPreview(r);
      if (!dryRun) { setNotice(`ルール生成: 新規 ${r.created} 件 / 更新 ${r.updated} 件`); setSelected(new Set()); await load(); }
    } catch (e: unknown) { setErr((e as Error).message); }
  }

  const toggle = (norm: string) => setSelected((s) => { const n = new Set(s); if (n.has(norm)) n.delete(norm); else n.add(norm); return n; });
  const selectAll = (rows: SheetRow[]) => setSelected(new Set(rows.filter((r) => r.status === "proposal" || (override && r.status === "differs")).map((r) => r.payee_norm)));

  return (
    <div>
      <h2>按分シート</h2>
      <div className="foundation-form" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label>年 <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} /></label>
        <label>状態 <select value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
          <option value="">すべて</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select></label>
        <button onClick={() => void collect()}>帳簿から観測を再構築</button>
        <label><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> 不一致も上書き</label>
        <button onClick={() => data && selectAll(data.rows)}>提案行を全選択</button>
        <button onClick={() => void synthesize(true)} disabled={!data}>ルール生成 (dry-run)</button>
        <button onClick={() => void synthesize(false)} disabled={!preview || preview.candidates.every((c) => c.action === "skip")}>適用</button>
      </div>
      {notice && <p>{notice}</p>}
      {err && <p className="error">{err}</p>}
      {data && (
        <p>観測 {data.observations} 件 / {Object.entries(data.counts).map(([k, v]) => `${STATUS_LABEL[k as Status] ?? k}: ${v}`).join(" ・ ")}</p>
      )}
      {preview && (
        <details open>
          <summary>生成候補 {preview.candidates.filter((c) => c.action !== "skip").length} 件 (skip {preview.candidates.filter((c) => c.action === "skip").length}) {preview.dry_run ? "— dry-run" : `— 適用済 ${preview.created + preview.updated} 件`}</summary>
          <table>
            <thead><tr><th>店</th><th>pattern</th><th>率</th><th>科目</th><th>優先</th><th>結果</th></tr></thead>
            <tbody>{preview.candidates.map((c) => (
              <tr key={c.payee_norm}><td>{c.payee_norm}</td><td><code>{c.pattern}</code></td><td>{Math.round(c.rate * 100)}%</td><td>{c.code} {codeName(c.code)}</td><td>{c.priority}</td><td>{c.action === "create" ? (c.rule_id ? `作成 #${c.rule_id}` : "作成予定") : c.action === "update" ? (preview.dry_run ? `更新予定 #${c.rule_id}` : `更新 #${c.rule_id}`) : `skip: ${c.reason}`}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
      {data && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th></th><th>店</th><th>状態</th><th>観測 (率 / 科目 × 回数)</th><th>提案</th><th>現行</th><th>{year} 年 支出</th><th>件数</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.payee_norm}>
                <td><input type="checkbox" checked={selected.has(r.payee_norm)} onChange={() => toggle(r.payee_norm)} disabled={r.status === "match" || r.status === "unknown"} /></td>
                <td>{r.payee_sample}</td>
                <td>{STATUS_LABEL[r.status]}</td>
                <td>{r.observations.map((o) => `${Math.round(o.rate * 100)}%/${o.code}×${o.occurrences}`).join(", ")}</td>
                <td>{r.proposed ? `${Math.round(r.proposed.rate * 100)}% ${r.proposed.code} ${codeName(r.proposed.code)}` : "-"}</td>
                <td>{r.current.rule_id === null ? "(既定 0% 124)" : `${Math.round(r.current.rate * 100)}% ${r.current.code} ${codeName(r.current.code)} #${r.current.rule_id}`}</td>
                <td style={{ textAlign: "right" }}>{yen(r.spend_in_year)}</td><td style={{ textAlign: "right" }}>{r.tx_count_in_year}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <HouseholdRulesEditor onError={setErr} />
    </div>
  );
}

function HouseholdRulesEditor({ onError }: { onError: (s: string | null) => void }) {
  const [rules, setRules] = useState<HouseholdRule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [form, setForm] = useState({ pattern: "", category_id: "", priority: "100" });
  const [newCategory, setNewCategory] = useState("");

  const load = useCallback(async () => {
    try {
      setRules((await jsonFetch<{ items: HouseholdRule[] }>("/v1/household/rules?include_disabled=1")).items);
      setCategories((await jsonFetch<{ items: Category[] }>("/v1/household/categories")).items);
    } catch (e: unknown) { onError((e as Error).message); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  async function addRule() {
    try {
      await jsonFetch("/v1/household/rules", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: form.pattern, category_id: Number(form.category_id), priority: Number(form.priority) }) });
      setForm({ ...form, pattern: "" });
      await load();
    } catch (e: unknown) { onError((e as Error).message); }
  }
  async function toggleRule(r: HouseholdRule) {
    try { await jsonFetch(`/v1/household/rules/${r.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !r.enabled }) }); await load(); }
    catch (e: unknown) { onError((e as Error).message); }
  }
  async function removeRule(id: number) {
    try { await jsonFetch(`/v1/household/rules/${id}`, { method: "DELETE" }); await load(); }
    catch (e: unknown) { onError((e as Error).message); }
  }
  async function addCategory() {
    try { await jsonFetch("/v1/household/categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newCategory }) }); setNewCategory(""); await load(); }
    catch (e: unknown) { onError((e as Error).message); }
  }
  const catName = (id: number) => categories.find((c) => c.id === id)?.name ?? `(${id})`;

  return (
    <details style={{ marginTop: 16 }}>
      <summary>家計費目ルール ({rules.length} 件) / 費目 ({categories.length})</summary>
      <div className="foundation-form" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="pattern (正規表現)" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
        <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
          <option value="">費目</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={{ width: 80 }} />
        <button onClick={() => void addRule()} disabled={!form.pattern || !form.category_id}>ルール追加</button>
        <span>|</span>
        <input placeholder="新しい費目名" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
        <button onClick={() => void addCategory()} disabled={!newCategory}>費目追加</button>
      </div>
      <table>
        <thead><tr><th>優先</th><th>pattern</th><th>費目</th><th>有効</th><th></th></tr></thead>
        <tbody>{rules.map((r) => (
          <tr key={r.id}><td>{r.priority}</td><td><code>{r.pattern}</code></td><td>{catName(r.category_id)}</td>
            <td><input type="checkbox" checked={!!r.enabled} onChange={() => void toggleRule(r)} /></td>
            <td><button onClick={() => void removeRule(r.id)}>削除</button></td></tr>
        ))}</tbody>
      </table>
    </details>
  );
}
