import { useCallback, useEffect, useState } from "react";
import { currentYear } from "../components/YearTabs.js";

/** 減価償却ページ: 固定資産台帳 / 年度の償却表 (エクセル簿記 ③) / 投影 / 仕訳計上。 API は /v1/depreciation。
 * @implements SPEC-DEPRECIATION-003 (spec/feature/depreciation.md) */

type Method = "straight_line" | "declining_balance" | "old_straight_line" | "old_declining_balance" | "lump_sum_3y" | "immediate";
const METHOD_LABEL: Record<Method, string> = {
  straight_line: "定額", declining_balance: "定率", old_straight_line: "旧定額", old_declining_balance: "旧定率",
  lump_sum_3y: "一括償却 (3年均等)", immediate: "即時 (少額)",
};
const NEEDS_LIFE = (m: Method) => m !== "lump_sum_3y" && m !== "immediate";

interface Asset {
  id: number; name: string; quantity: string | null; acquired_on: string; cost: number; method: Method; useful_life: number;
  business_ratio: number; asset_code: number; expense_code: number; opening_book_value: number | null; opening_year: number | null;
  revised_cost: number | null; disposed_on: string | null; notes: string | null; family?: string | null;
}
interface YearRow {
  year: number; months: number; opening_book: number; basis: number; rate: number; family: string | null; revised: boolean;
  ordinary: number; extra: number; total: number; expense: number; household: number; closing_book: number;
}
interface ScheduleRow extends YearRow {
  asset_id: number; name: string; quantity: string | null; acquired_on: string; cost: number; method: Method; useful_life: number;
  business_ratio: number; asset_code: number; expense_code: number; notes: string | null;
}
interface Schedule { year: number; rows: ScheduleRow[]; totals: { ordinary: number; extra: number; total: number; expense: number; household: number; closing_book: number } }
interface AccountCode { code: number; name: string; kind: string }

const yen = (n: number) => n.toLocaleString("ja-JP");
const pct = (r: number) => `${Math.round(r * 100)}%`;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json() as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

const EMPTY_FORM = {
  name: "", quantity: "", acquired_on: `${currentYear()}-01-01`, cost: "", method: "straight_line" as Method, useful_life: "4",
  business_ratio: "100", asset_code: "115", expense_code: "18", opening_year: "", opening_book_value: "", disposed_on: "", notes: "",
};

export function Depreciation() {
  const [year, setYear] = useState(Number(currentYear()));
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [accounts, setAccounts] = useState<AccountCode[]>([]);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [projection, setProjection] = useState<{ asset: Asset; rows: YearRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSchedule(await jsonFetch<Schedule>(`/v1/depreciation/${year}/schedule`));
      setAssets((await jsonFetch<{ items: Asset[] }>("/v1/depreciation/assets")).items);
      setErr(null);
    } catch (e: unknown) { setErr((e as Error).message); }
  }, [year]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void jsonFetch<{ items: AccountCode[] }>("/v1/account-codes").then((j) => setAccounts(j.items)).catch(() => undefined); }, []);

  const codeName = (c: number) => accounts.find((a) => a.code === c)?.name ?? "";

  function startEdit(a: Asset) {
    setEditingId(a.id);
    setForm({
      name: a.name, quantity: a.quantity ?? "", acquired_on: a.acquired_on, cost: String(a.cost), method: a.method, useful_life: String(a.useful_life || 4),
      business_ratio: String(Math.round(a.business_ratio * 100)), asset_code: String(a.asset_code), expense_code: String(a.expense_code),
      opening_year: a.opening_year ? String(a.opening_year) : "", opening_book_value: a.opening_book_value != null ? String(a.opening_book_value) : "",
      disposed_on: a.disposed_on ?? "", notes: a.notes ?? "",
    });
  }

  async function save() {
    const body = {
      name: form.name, quantity: form.quantity || null, acquired_on: form.acquired_on, cost: Number(form.cost), method: form.method,
      useful_life: NEEDS_LIFE(form.method) ? Number(form.useful_life) : 0, business_ratio: Number(form.business_ratio) / 100,
      asset_code: Number(form.asset_code), expense_code: Number(form.expense_code),
      opening_year: form.opening_year ? Number(form.opening_year) : null, opening_book_value: form.opening_book_value ? Number(form.opening_book_value) : null,
      disposed_on: form.disposed_on || null, notes: form.notes || null,
    };
    try {
      if (editingId === null) await jsonFetch("/v1/depreciation/assets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      else await jsonFetch(`/v1/depreciation/assets/${editingId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setForm({ ...EMPTY_FORM });
      setEditingId(null);
      await load();
    } catch (e: unknown) { setErr((e as Error).message); }
  }

  async function remove(id: number) {
    const asset = assets.find((a) => a.id === id);
    if (!window.confirm(`「${asset?.name ?? id}」と、この資産から計上した仕訳を削除しますか？`)) return;
    try {
      await jsonFetch(`/v1/depreciation/assets/${id}`, { method: "DELETE" });
      if (editingId === id) { setEditingId(null); setForm({ ...EMPTY_FORM }); }
      if (projection?.asset.id === id) setProjection(null);
      await load();
    } catch (e: unknown) { setErr((e as Error).message); }
  }

  async function showProjection(id: number) {
    try { setProjection(await jsonFetch<{ asset: Asset; rows: YearRow[] }>(`/v1/depreciation/assets/${id}/projection`)); }
    catch (e: unknown) { setErr((e as Error).message); }
  }

  async function post() {
    try {
      const r = await jsonFetch<{ posted: number; deleted: number; assets: number; accounts_added: number }>(`/v1/depreciation/${year}/post`, { method: "POST" });
      setNotice(`仕訳に計上: ${r.posted} 行 (${r.assets} 資産、 入替 ${r.deleted} 行、 科目追加 ${r.accounts_added})`);
    } catch (e: unknown) { setErr((e as Error).message); }
  }

  const assetAccounts = accounts.filter((a) => a.kind === "asset");
  const expenseAccounts = accounts.filter((a) => a.kind === "expense");

  return (
    <div>
      <h2>減価償却</h2>
      <div className="foundation-form" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label>年 <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} /></label>
        <button onClick={() => void post()} disabled={!schedule || schedule.rows.length === 0}>仕訳に計上 ({year} 年末)</button>
      </div>
      {notice && <p>{notice}</p>}
      {err && <p className="error">{err}</p>}

      <h3>減価償却費の計算 ({year} 年)</h3>
      {schedule && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>名称</th><th>取得年月</th><th>取得価額 (イ)</th><th>償却の基礎 (ロ)</th><th>方法</th><th>耐用</th><th>率 (ハ)</th><th>期間 (ニ)</th><th>普通償却費 (ホ)</th><th>合計 (ト)</th><th>事業割合 (チ)</th><th>経費算入 (リ)</th><th>未償却残高 (ヌ)</th></tr></thead>
            <tbody>
              {schedule.rows.map((r) => (
                <tr key={r.asset_id}>
                  <td>{r.name}</td><td>{r.acquired_on.slice(0, 7)}</td><td style={{ textAlign: "right" }}>{yen(r.cost)}</td><td style={{ textAlign: "right" }}>{yen(r.basis)}</td>
                  <td>{METHOD_LABEL[r.method]}{r.family ? ` (${r.family}${r.revised ? "・改定" : ""})` : ""}</td><td>{r.useful_life || "-"}</td>
                  <td>{r.rate ? r.rate.toFixed(3) : "-"}</td><td>{r.months} 月</td><td style={{ textAlign: "right" }}>{yen(r.ordinary)}</td>
                  <td style={{ textAlign: "right" }}>{yen(r.total)}</td><td>{pct(r.business_ratio)}</td><td style={{ textAlign: "right" }}><b>{yen(r.expense)}</b></td><td style={{ textAlign: "right" }}>{yen(r.closing_book)}</td>
                </tr>
              ))}
              <tr><td><b>合計</b></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
                <td style={{ textAlign: "right" }}><b>{yen(schedule.totals.ordinary)}</b></td><td style={{ textAlign: "right" }}><b>{yen(schedule.totals.total)}</b></td><td></td>
                <td style={{ textAlign: "right" }}><b>{yen(schedule.totals.expense)}</b></td><td style={{ textAlign: "right" }}><b>{yen(schedule.totals.closing_book)}</b></td></tr>
            </tbody>
          </table>
        </div>
      )}

      <h3>固定資産台帳</h3>
      <div className="foundation-form" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="数量" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} style={{ width: 80 }} />
        <label>取得日 <input type="date" value={form.acquired_on} onChange={(e) => setForm({ ...form, acquired_on: e.target.value })} /></label>
        <input type="number" placeholder="取得価額" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} style={{ width: 120 }} />
        <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as Method })}>
          {(Object.keys(METHOD_LABEL) as Method[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </select>
        {NEEDS_LIFE(form.method) && <label>耐用年数 <input type="number" min={2} max={50} value={form.useful_life} onChange={(e) => setForm({ ...form, useful_life: e.target.value })} style={{ width: 60 }} /></label>}
        <label>事業割合% <input type="number" min={0} max={100} value={form.business_ratio} onChange={(e) => setForm({ ...form, business_ratio: e.target.value })} style={{ width: 60 }} /></label>
        <select value={form.asset_code} onChange={(e) => setForm({ ...form, asset_code: e.target.value })}>
          {assetAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
          {!assetAccounts.some((a) => a.code === 115) && <option value="115">115 備品</option>}
        </select>
        <select value={form.expense_code} onChange={(e) => setForm({ ...form, expense_code: e.target.value })}>
          {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
          {!expenseAccounts.some((a) => a.code === 18) && <option value="18">18 減価償却費</option>}
        </select>
        <label>期首年 <input type="number" placeholder="任意" value={form.opening_year} onChange={(e) => setForm({ ...form, opening_year: e.target.value })} style={{ width: 80 }} /></label>
        <label>期首簿価 <input type="number" placeholder="任意" value={form.opening_book_value} onChange={(e) => setForm({ ...form, opening_book_value: e.target.value })} style={{ width: 110 }} /></label>
        <label>除却日 <input type="date" value={form.disposed_on} onChange={(e) => setForm({ ...form, disposed_on: e.target.value })} /></label>
        <input placeholder="摘要" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <button onClick={() => void save()} disabled={!form.name || !form.cost}>{editingId === null ? "追加" : "更新"}</button>
        {editingId !== null && <button onClick={() => { setEditingId(null); setForm({ ...EMPTY_FORM }); }}>取消</button>}
      </div>
      <table>
        <thead><tr><th>名称</th><th>取得日</th><th>取得価額</th><th>方法</th><th>耐用</th><th>事業割合</th><th>資産科目</th><th>費用科目</th><th>除却</th><th></th></tr></thead>
        <tbody>{assets.map((a) => (
          <tr key={a.id}>
            <td>{a.name}{a.quantity ? ` (${a.quantity})` : ""}</td><td>{a.acquired_on}</td><td style={{ textAlign: "right" }}>{yen(a.cost)}</td>
            <td>{METHOD_LABEL[a.method]}{a.family ? ` / ${a.family}` : ""}</td><td>{a.useful_life || "-"}</td><td>{pct(a.business_ratio)}</td>
            <td>{a.asset_code} {codeName(a.asset_code)}</td><td>{a.expense_code} {codeName(a.expense_code)}</td><td>{a.disposed_on ?? ""}</td>
            <td><button onClick={() => void showProjection(a.id)}>投影</button> <button onClick={() => startEdit(a)}>編集</button> <button onClick={() => void remove(a.id)}>削除</button></td>
          </tr>
        ))}</tbody>
      </table>

      {projection && (
        <details open style={{ marginTop: 12 }}>
          <summary>{projection.asset.name} の投影 (取得〜除却・償却完了)</summary>
          <table>
            <thead><tr><th>年</th><th>期間</th><th>期首簿価</th><th>基礎</th><th>率</th><th>償却費</th><th>経費算入</th><th>家計分</th><th>期末簿価</th></tr></thead>
            <tbody>{projection.rows.map((r) => (
              <tr key={r.year}><td>{r.year}</td><td>{r.months} 月</td><td style={{ textAlign: "right" }}>{yen(r.opening_book)}</td><td style={{ textAlign: "right" }}>{yen(r.basis)}</td>
                <td>{r.rate ? r.rate.toFixed(3) : "-"}{r.revised ? " (改定)" : ""}</td><td style={{ textAlign: "right" }}>{yen(r.total)}</td>
                <td style={{ textAlign: "right" }}>{yen(r.expense)}</td><td style={{ textAlign: "right" }}>{yen(r.household)}</td><td style={{ textAlign: "right" }}>{yen(r.closing_book)}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
    </div>
  );
}
