import { Fragment, useCallback, useEffect, useState } from "react";
import { YearTabs, currentYear } from "../components/YearTabs.js";

/** 簿記ページ: 仕訳帳 / 精算表 / 元帳 / 月別 / 決算書 / 期首残高。 API は /v1/bookkeeping。
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-001 (spec/feature/household-bookkeeping.md) */

type SubTab = "journal" | "trial" | "ledger" | "monthly" | "report" | "opening";
const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "journal", label: "仕訳帳" },
  { key: "trial", label: "精算表" },
  { key: "ledger", label: "元帳" },
  { key: "monthly", label: "月別集計" },
  { key: "report", label: "決算書" },
  { key: "opening", label: "期首残高" },
];

interface JournalEntry {
  id: number; fiscal_year: number; entry_date: string; no: number;
  debit_code: number; debit_amount: number; credit_code: number; credit_amount: number;
  description: string; payment: number; rate: number;
  origin: "transaction" | "manual" | "imported"; leg: string | null;
  household_category_id: number | null; household_category_name: string | null; locked: number;
}
interface AccountCode { code: number; name: string; kind: string }
interface Category { id: number; name: string }
interface TrialRow {
  code: number; name: string; kind: string; opening_debit: number; opening_credit: number;
  debit_total: number; credit_total: number; pl_debit: number; pl_credit: number; bs_debit: number; bs_credit: number;
}
interface TrialRes { rows: TrialRow[]; subtotal: Record<string, number>; total: Record<string, number>; income: number; opening_equity: number; unknown_codes: number[] }
interface LedgerLine { entry_id: number; entry_date: string; no: number; counter_code: number; counter_name: string; description: string; debit: number; credit: number; balance: number }
interface LedgerRes { code: number; name: string; opening: number; lines: LedgerLine[]; debit_total: number; credit_total: number; closing: number }
interface MonthlyAccount { code: number; name: string; months: number[]; total: number; by_description: { description: string; months: number[]; total: number }[] }
interface MonthlyRes { accounts: MonthlyAccount[]; monthly_sales: number[]; sales_total: number }
interface ReportRes {
  pl: { revenues: { code: number; name: string; amount: number }[]; sales_total: number; expenses: { code: number; name: string; amount: number }[]; expense_total: number; income: number };
  bs: { assets: { code: number; name: string; opening: number; closing: number }[]; liabilities: { code: number; name: string; opening: number; closing: number }[];
    assets_opening_total: number; assets_closing_total: number; liabilities_opening_total: number; liabilities_closing_total: number; income: number; balanced: boolean };
}

const yen = (n: number) => n.toLocaleString("ja-JP");
const MANUAL_TEMPLATES = [
  ["sales_deposit", "売上入金 (102/1)"], ["sales_with_withholding", "売上入金 + 源泉税 (102,117/1)"], ["cash_withdrawal", "現金引出 (101/102)"],
  ["interest", "利息 (102/172)"], ["rent", "家賃 (23/102)"], ["resident_tax", "住民税等 家計 (124/102)"], ["household_bank", "家計引落 (124/102)"],
  ["cash_expense", "現金経費 (<科目>/101)"], ["custom", "任意"],
] as const;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json() as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

export function Bookkeeping() {
  const [year, setYear] = useState(currentYear());
  const [tab, setTab] = useState<SubTab>("journal");
  const [accounts, setAccounts] = useState<AccountCode[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void jsonFetch<{ items: AccountCode[] }>("/v1/account-codes").then((j) => setAccounts(j.items)).catch((e: Error) => setErr(e.message));
    void jsonFetch<{ items: Category[] }>("/v1/household/categories").then((j) => setCategories(j.items)).catch((e: Error) => setErr(e.message));
  }, []);

  const y = Number(year);

  async function rebuild() {
    setErr(null);
    try {
      const r = await jsonFetch<{ generated: number; deleted: number; kept_locked: number }>(`/v1/bookkeeping/${y}/rebuild`, { method: "POST" });
      setNotice(`再生成: ${r.generated} 行生成 / ${r.deleted} 行削除 / ロック保持 ${r.kept_locked}`);
    } catch (e: unknown) { setErr((e as Error).message); }
  }

  async function importXlsx(file: File) {
    setErr(null);
    const buf = await file.arrayBuffer();
    let bin = "";
    new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
    try {
      const r = await jsonFetch<{ inserted: number; fiscal_years: number[]; accounts_added: number; observations: number; header_row: number }>(
        "/v1/bookkeeping/import-journal",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content_b64: btoa(bin) }) },
      );
      setNotice(`取込: ${r.inserted} 行 (年度 ${r.fiscal_years.join(", ")}, ヘッダ行 ${r.header_row}, 科目追加 ${r.accounts_added}, 観測 ${r.observations})`);
    } catch (e: unknown) { setErr((e as Error).message); }
  }

  return (
    <div>
      <h2>簿記 (エクセル簿記互換)</h2>
      <YearTabs value={year} onChange={(yy) => setYear(yy)} fallback={[currentYear()]} showAll={false} />
      <div className="foundation-form" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => void rebuild()}>取引から仕訳帳を再生成</button>
        <a href={`/v1/bookkeeping/${y}/workbook.xlsx`}><button>ブック出力 (.xlsx)</button></a>
        <label>エクセル簿記の仕訳帳を取込 <input type="file" accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importXlsx(f); e.target.value = ""; }} /></label>
      </div>
      {notice && <p>{notice}</p>}
      {err && <p className="error">{err}</p>}
      <nav style={{ display: "flex", gap: 6, margin: "8px 0" }}>
        {SUB_TABS.map((t) => <button key={t.key} aria-current={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </nav>
      {tab === "journal" && <JournalTab year={y} accounts={accounts} categories={categories} onError={setErr} />}
      {tab === "trial" && <TrialTab year={y} />}
      {tab === "ledger" && <LedgerTab year={y} accounts={accounts} />}
      {tab === "monthly" && <MonthlyTab year={y} />}
      {tab === "report" && <ReportTab year={y} />}
      {tab === "opening" && <OpeningTab year={y} accounts={accounts} onError={setErr} />}
    </div>
  );
}

type JournalView = "all" | "by-account";

function JournalTab({ year, accounts, categories, onError }: { year: number; accounts: AccountCode[]; categories: Category[]; onError: (s: string | null) => void }) {
  const [items, setItems] = useState<JournalEntry[]>([]);
  const [month, setMonth] = useState<string>("");
  const [view, setView] = useState<JournalView>("all");
  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [manual, setManual] = useState({ template: "sales_deposit", entry_date: `${year}-01-01`, amount: "", description: "", debit_code: "", credit_code: "" });

  const load = useCallback(async () => {
    const q = month ? `?month=${month}` : "";
    try { setItems((await jsonFetch<{ items: JournalEntry[] }>(`/v1/bookkeeping/${year}/journal${q}`)).items); onError(null); }
    catch (e: unknown) { onError((e as Error).message); }
  }, [year, month, onError]);
  useEffect(() => { void load(); }, [load]);

  const name = (code: number) => accounts.find((a) => a.code === code)?.name ?? `(${code})`;

  async function save() {
    if (!editing) return;
    try {
      await jsonFetch(`/v1/bookkeeping/journal/${editing.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          debit_code: editing.debit_code, debit_amount: editing.debit_amount, credit_code: editing.credit_code, credit_amount: editing.credit_amount,
          description: editing.description, rate: editing.rate, household_category_id: editing.household_category_id,
        }),
      });
      setEditing(null);
      await load();
    } catch (e: unknown) { onError((e as Error).message); }
  }

  /** 削除は編集モードの中だけに出す (誤爆防止)。 さらに確認ダイアログを挟む */
  async function remove(e: JournalEntry) {
    if (!window.confirm(`№${e.no} ${e.entry_date} ${e.description} (${yen(e.debit_amount)}) を削除しますか?`)) return;
    try { await jsonFetch(`/v1/bookkeeping/journal/${e.id}`, { method: "DELETE" }); setEditing(null); await load(); }
    catch (err: unknown) { onError((err as Error).message); }
  }

  async function addManual() {
    try {
      await jsonFetch(`/v1/bookkeeping/${year}/journal`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template: manual.template, entry_date: manual.entry_date, amount: Number(manual.amount), description: manual.description,
          debit_code: manual.debit_code ? Number(manual.debit_code) : undefined, credit_code: manual.credit_code ? Number(manual.credit_code) : undefined,
        }),
      });
      setManual({ ...manual, amount: "", description: "" });
      await load();
    } catch (e: unknown) { onError((e as Error).message); }
  }

  /** 科目別: 借方科目コードで束ねる (経費は借方に出る)。 コード昇順 */
  const groups = (() => {
    if (view === "all") return [{ code: null as number | null, rows: items }];
    const m = new Map<number, JournalEntry[]>();
    for (const e of items) { const arr = m.get(e.debit_code) ?? []; arr.push(e); m.set(e.debit_code, arr); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([code, rows]) => ({ code, rows }));
  })();

  const renderRow = (e: JournalEntry) => editing?.id === e.id ? (
    <tr key={e.id} className="foundation-form journal-editing">
      <td className="nowrap">{e.entry_date}</td><td>{e.no}</td>
      <td className="nowrap"><select value={editing.debit_code} onChange={(ev) => setEditing({ ...editing, debit_code: Number(ev.target.value) })}>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></td>
      <td className="num"><input type="number" style={{ width: 110 }} value={editing.debit_amount} onChange={(ev) => setEditing({ ...editing, debit_amount: Number(ev.target.value), credit_amount: Number(ev.target.value) })} /></td>
      <td className="nowrap"><select value={editing.credit_code} onChange={(ev) => setEditing({ ...editing, credit_code: Number(ev.target.value) })}>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></td>
      <td className="num">{yen(editing.credit_amount)}</td>
      <td><input value={editing.description} onChange={(ev) => setEditing({ ...editing, description: ev.target.value })} /></td>
      <td className="num">{yen(e.payment)}</td>
      <td><input type="number" step="0.1" min="0" max="1" style={{ width: 60 }} value={editing.rate} onChange={(ev) => setEditing({ ...editing, rate: Number(ev.target.value) })} /></td>
      <td><select value={editing.household_category_id ?? ""} onChange={(ev) => setEditing({ ...editing, household_category_id: ev.target.value ? Number(ev.target.value) : null })}>
        <option value="">-</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
      <td>{e.origin}</td>
      <td className="nowrap">
        <button onClick={() => void save()}>保存</button> <button onClick={() => setEditing(null)}>取消</button>{" "}
        <button className="danger" onClick={() => void remove(e)}>削除</button>
      </td>
    </tr>
  ) : (
    <tr key={e.id}>
      <td className="nowrap">{e.entry_date}</td><td>{e.no}</td>
      <td className="nowrap">{e.debit_code} {name(e.debit_code)}</td><td className="num">{yen(e.debit_amount)}</td>
      <td className="nowrap">{e.credit_code} {name(e.credit_code)}</td><td className="num">{yen(e.credit_amount)}</td>
      <td>{e.description}</td><td className="num">{yen(e.payment)}</td>
      <td className="num">{Math.round(e.rate * 100)}%</td>
      <td>{e.household_category_name ?? ""}</td>
      <td className="nowrap">{e.origin}{e.locked ? " 🔒" : ""}</td>
      <td className="nowrap"><button onClick={() => setEditing(e)}>編集</button></td>
    </tr>
  );

  return (
    <div>
      <div className="foundation-form" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label>月 <select value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">全月</option>
          {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}月</option>)}
        </select></label>
        <span>表示:</span>
        <button aria-pressed={view === "all"} onClick={() => setView("all")}>全仕訳</button>
        <button aria-pressed={view === "by-account"} onClick={() => setView("by-account")}>科目別</button>
        <span>{items.length} 行</span>
      </div>
      <details className="foundation-form" style={{ margin: "8px 0" }}>
        <summary>手動仕訳を追加 (特殊仕訳テンプレート)</summary>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={manual.template} onChange={(e) => setManual({ ...manual, template: e.target.value })}>
            {MANUAL_TEMPLATES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input type="date" value={manual.entry_date} onChange={(e) => setManual({ ...manual, entry_date: e.target.value })} />
          <input type="number" placeholder="金額" value={manual.amount} onChange={(e) => setManual({ ...manual, amount: e.target.value })} />
          <input placeholder="摘要" value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} />
          {(manual.template === "cash_expense" || manual.template === "custom") && (
            <select value={manual.debit_code} onChange={(e) => setManual({ ...manual, debit_code: e.target.value })}>
              <option value="">借方科目</option>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
          )}
          {manual.template === "custom" && (
            <select value={manual.credit_code} onChange={(e) => setManual({ ...manual, credit_code: e.target.value })}>
              <option value="">貸方科目</option>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
          )}
          <button onClick={() => void addManual()}>追加</button>
        </div>
      </details>
      <div style={{ overflowX: "auto" }}>
        <table className="journal-table">
          <colgroup>
            <col style={{ width: 110 }} /><col style={{ width: 52 }} /><col style={{ width: 190 }} /><col style={{ width: 120 }} />
            <col style={{ width: 190 }} /><col style={{ width: 120 }} /><col /><col style={{ width: 120 }} /><col style={{ width: 64 }} /><col style={{ width: 140 }} /><col style={{ width: 96 }} /><col style={{ width: 170 }} />
          </colgroup>
          <thead><tr><th>日付</th><th>№</th><th>借方</th><th>金額</th><th>貸方</th><th>金額</th><th>摘要</th><th>支払</th><th>按分</th><th>家計費目</th><th>由来</th><th></th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.code ?? "all"}>
                {g.code !== null && (
                  <tr className="journal-group">
                    <td colSpan={3}><b>{g.code} {name(g.code)}</b></td>
                    <td className="num"><b>{yen(g.rows.reduce((t, r) => t + r.debit_amount, 0))}</b></td>
                    <td colSpan={8}>{g.rows.length} 件</td>
                  </tr>
                )}
                {g.rows.map(renderRow)}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TrialTab({ year }: { year: number }) {
  const [data, setData] = useState<TrialRes | null>(null);
  useEffect(() => { void jsonFetch<TrialRes>(`/v1/bookkeeping/${year}/trial-balance`).then(setData).catch(() => setData(null)); }, [year]);
  if (!data) return <p>loading…</p>;
  const cols: (keyof TrialRow)[] = ["opening_debit", "opening_credit", "debit_total", "credit_total", "pl_debit", "pl_credit", "bs_debit", "bs_credit"];
  return (
    <div style={{ overflowX: "auto" }}>
      {data.unknown_codes.length > 0 && <p className="error">科目コードにない値が仕訳帳にあります: {data.unknown_codes.join(", ")}</p>}
      <table>
        <thead><tr><th>コード</th><th>科目</th><th>期首 借方</th><th>期首 貸方</th><th>試算表 借方</th><th>試算表 貸方</th><th>PL 借方</th><th>PL 貸方</th><th>BS 借方</th><th>BS 貸方</th></tr></thead>
        <tbody>
          {data.rows.filter((r) => cols.some((c) => r[c] !== 0)).map((r) => (
            <tr key={r.code}><td>{r.code}</td><td>{r.name}</td>{cols.map((c) => <td key={c} style={{ textAlign: "right" }}>{r[c] ? yen(r[c] as number) : ""}</td>)}</tr>
          ))}
          <tr><td></td><td><b>準計</b></td>{cols.map((c) => <td key={c} style={{ textAlign: "right" }}><b>{yen(data.subtotal[c] ?? 0)}</b></td>)}</tr>
          {data.opening_equity !== 0 && <tr><td></td><td>元入金（期首差額）</td><td></td><td></td><td></td><td></td><td></td><td></td>
            <td style={{ textAlign: "right" }}>{data.opening_equity < 0 ? yen(-data.opening_equity) : ""}</td>
            <td style={{ textAlign: "right" }}>{data.opening_equity > 0 ? yen(data.opening_equity) : ""}</td></tr>}
          <tr><td></td><td>青色申告特別控除前の所得金額</td><td></td><td></td><td></td><td></td>
            <td style={{ textAlign: "right" }}>{data.income > 0 ? yen(data.income) : ""}</td><td style={{ textAlign: "right" }}>{data.income < 0 ? yen(-data.income) : ""}</td>
            <td style={{ textAlign: "right" }}>{data.income < 0 ? yen(-data.income) : ""}</td><td style={{ textAlign: "right" }}>{data.income > 0 ? yen(data.income) : ""}</td></tr>
          <tr><td></td><td><b>合計</b></td>{cols.map((c) => <td key={c} style={{ textAlign: "right" }}><b>{yen(data.total[c] ?? 0)}</b></td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}

function LedgerTab({ year, accounts }: { year: number; accounts: AccountCode[] }) {
  const [code, setCode] = useState<number>(102);
  const [data, setData] = useState<LedgerRes | null>(null);
  useEffect(() => { void jsonFetch<LedgerRes>(`/v1/bookkeeping/${year}/ledger/${code}`).then(setData).catch(() => setData(null)); }, [year, code]);
  return (
    <div>
      <div className="foundation-form"><label>科目 <select value={code} onChange={(e) => setCode(Number(e.target.value))}>
        {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label></div>
      {data && (
        <div style={{ overflowX: "auto" }}>
          <p>期首 {yen(data.opening)} / 借方計 {yen(data.debit_total)} / 貸方計 {yen(data.credit_total)} / 期末 <b>{yen(data.closing)}</b></p>
          <table>
            <thead><tr><th>日付</th><th>№</th><th>相手科目</th><th>摘要</th><th>借方</th><th>貸方</th><th>残高</th></tr></thead>
            <tbody>{data.lines.map((l, i) => (
              <tr key={`${l.entry_id}-${i}`}><td>{l.entry_date}</td><td>{l.no}</td><td>{l.counter_code} {l.counter_name}</td><td>{l.description}</td>
                <td style={{ textAlign: "right" }}>{l.debit ? yen(l.debit) : ""}</td><td style={{ textAlign: "right" }}>{l.credit ? yen(l.credit) : ""}</td><td style={{ textAlign: "right" }}>{yen(l.balance)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MonthlyTab({ year }: { year: number }) {
  const [data, setData] = useState<MonthlyRes | null>(null);
  useEffect(() => { void jsonFetch<MonthlyRes>(`/v1/bookkeeping/${year}/monthly`).then(setData).catch(() => setData(null)); }, [year]);
  if (!data) return <p>loading…</p>;
  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead><tr><th>科目</th><th>摘要</th>{months.map((m) => <th key={m}>{m}</th>)}<th>年間</th></tr></thead>
        <tbody>
          <tr><td><b>売上 (月別)</b></td><td></td>{data.monthly_sales.map((v, i) => <td key={i} style={{ textAlign: "right" }}>{v ? yen(v) : ""}</td>)}<td style={{ textAlign: "right" }}><b>{yen(data.sales_total)}</b></td></tr>
          {data.accounts.map((a) => (
            <Fragment key={a.code}>
              <tr><td><b>{a.code} {a.name}</b></td><td>(合計)</td>{a.months.map((v, i) => <td key={i} style={{ textAlign: "right" }}>{v ? yen(v) : ""}</td>)}<td style={{ textAlign: "right" }}><b>{yen(a.total)}</b></td></tr>
              {a.by_description.slice(0, 20).map((d) => (
                <tr key={`${a.code}-${d.description}`}><td></td><td>{d.description}</td>{d.months.map((v, i) => <td key={i} style={{ textAlign: "right" }}>{v ? yen(v) : ""}</td>)}<td style={{ textAlign: "right" }}>{yen(d.total)}</td></tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportTab({ year }: { year: number }) {
  const [data, setData] = useState<ReportRes | null>(null);
  useEffect(() => { void jsonFetch<ReportRes>(`/v1/bookkeeping/${year}/report`).then(setData).catch(() => setData(null)); }, [year]);
  if (!data) return <p>loading…</p>;
  return (
    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
      <div>
        <h3>損益計算書</h3>
        <table><tbody>
          {data.pl.revenues.map((r) => <tr key={r.code}><td>{r.code} {r.name}</td><td style={{ textAlign: "right" }}>{yen(r.amount)}</td></tr>)}
          <tr><td><b>売上 (収入) 合計</b></td><td style={{ textAlign: "right" }}><b>{yen(data.pl.sales_total)}</b></td></tr>
          {data.pl.expenses.map((r) => <tr key={r.code}><td>{r.code} {r.name}</td><td style={{ textAlign: "right" }}>{yen(r.amount)}</td></tr>)}
          <tr><td><b>経費 合計</b></td><td style={{ textAlign: "right" }}><b>{yen(data.pl.expense_total)}</b></td></tr>
          <tr><td><b>青色申告特別控除前の所得金額</b></td><td style={{ textAlign: "right" }}><b>{yen(data.pl.income)}</b></td></tr>
        </tbody></table>
      </div>
      <div>
        <h3>貸借対照表 {data.bs.balanced ? "" : <span className="error">(貸借不一致)</span>}</h3>
        <table>
          <thead><tr><th>資産</th><th>期首</th><th>期末</th><th>負債・資本</th><th>期首</th><th>期末</th></tr></thead>
          <tbody>
            {Array.from({ length: Math.max(data.bs.assets.length, data.bs.liabilities.length + 1) }, (_, i) => {
              const a = data.bs.assets[i]; const l = data.bs.liabilities[i];
              return (
                <tr key={i}>
                  <td>{a ? `${a.code} ${a.name}` : ""}</td><td style={{ textAlign: "right" }}>{a ? yen(a.opening) : ""}</td><td style={{ textAlign: "right" }}>{a ? yen(a.closing) : ""}</td>
                  {l ? <><td>{l.code} {l.name}</td><td style={{ textAlign: "right" }}>{yen(l.opening)}</td><td style={{ textAlign: "right" }}>{yen(l.closing)}</td></>
                    : i === data.bs.liabilities.length ? <><td>青色申告特別控除前の所得金額</td><td></td><td style={{ textAlign: "right" }}>{yen(data.bs.income)}</td></> : <><td></td><td></td><td></td></>}
                </tr>
              );
            })}
            <tr><td><b>合計</b></td><td style={{ textAlign: "right" }}><b>{yen(data.bs.assets_opening_total)}</b></td><td style={{ textAlign: "right" }}><b>{yen(data.bs.assets_closing_total)}</b></td>
              <td><b>合計</b></td><td style={{ textAlign: "right" }}><b>{yen(data.bs.liabilities_opening_total)}</b></td><td style={{ textAlign: "right" }}><b>{yen(data.bs.liabilities_closing_total + data.bs.income)}</b></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OpeningTab({ year, accounts, onError }: { year: number; accounts: AccountCode[]; onError: (s: string | null) => void }) {
  const [balances, setBalances] = useState<Record<number, string>>({});
  useEffect(() => {
    void jsonFetch<{ balances: { code: number; amount: number }[] }>(`/v1/bookkeeping/${year}/opening`)
      .then((j) => { const m: Record<number, string> = {}; for (const b of j.balances) m[b.code] = String(b.amount); setBalances(m); })
      .catch((e: Error) => onError(e.message));
  }, [year, onError]);
  const bsAccounts = accounts.filter((a) => a.kind === "asset" || a.kind === "liability");
  async function save() {
    const list = Object.entries(balances).filter(([, v]) => v !== "" && Number.isFinite(Number(v))).map(([code, v]) => ({ code: Number(code), amount: Math.round(Number(v)) }));
    try { await jsonFetch(`/v1/bookkeeping/${year}/opening`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ balances: list }) }); onError(null); }
    catch (e: unknown) { onError((e as Error).message); }
  }
  return (
    <div className="foundation-form">
      <p>期首残高 (前年の貸借対照表 期末)。 資産は借方残高、 負債・資本は貸方残高を入れる。</p>
      <table><tbody>
        {bsAccounts.map((a) => (
          <tr key={a.code}><td>{a.code} {a.name}</td><td>{a.kind === "asset" ? "資産" : "負債・資本"}</td>
            <td><input type="number" value={balances[a.code] ?? ""} onChange={(e) => setBalances({ ...balances, [a.code]: e.target.value })} /></td></tr>
        ))}
      </tbody></table>
      <button onClick={() => void save()}>保存</button>
    </div>
  );
}
