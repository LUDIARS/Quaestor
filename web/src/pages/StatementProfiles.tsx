import { useEffect, useState } from "react";

/**
 * 明細プロファイル管理。 クレカ等の CSV 列マッピングを外部登録する。
 * UFJ/SMBC は組込 importer があるので、 ここは他社カード追加用。
 */

interface ProfileRow {
  id: number;
  name: string;
  brand: string;
  source: string;
  encoding: string;
  header_skip: number;
  col_date: number;
  col_payee: number;
  col_amount: number;
  col_memo: number | null;
  amount_sign: string;
  filter_col: number | null;
  filter_value: string | null;
  date_year_hint: number | null;
  account_default: string | null;
  detect_keywords: string | null;
  enabled: number;
}

const EMPTY = {
  name: "", brand: "", source: "credit-card", encoding: "auto",
  header_skip: "1", col_date: "0", col_payee: "1", col_amount: "2",
  col_memo: "", amount_sign: "out", filter_col: "", filter_value: "",
  date_year_hint: "", account_default: "", detect_keywords: "",
};

export function StatementProfiles() {
  const [list, setList] = useState<ProfileRow[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const j = await fetch("/v1/statement-profiles").then((r) => r.json() as Promise<{ items: ProfileRow[] }>);
      setList(j.items);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  function num(s: string): number { return parseInt(s || "0", 10); }
  function numOrNull(s: string): number | null { return s.trim() === "" ? null : parseInt(s, 10); }

  async function save() {
    setErr(null);
    const body = {
      name: form.name,
      brand: form.brand,
      source: form.source,
      encoding: form.encoding,
      header_skip: num(form.header_skip),
      col_date: num(form.col_date),
      col_payee: num(form.col_payee),
      col_amount: num(form.col_amount),
      col_memo: numOrNull(form.col_memo),
      amount_sign: form.amount_sign,
      filter_col: numOrNull(form.filter_col),
      filter_value: form.filter_value.trim() || null,
      date_year_hint: numOrNull(form.date_year_hint),
      account_default: form.account_default.trim() || null,
      detect_keywords: form.detect_keywords.split(",").map((s) => s.trim()).filter(Boolean),
    };
    try {
      const path = editingId ? `/v1/statement-profiles/${editingId}` : "/v1/statement-profiles";
      const res = await fetch(path, {
        method: editingId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json() as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setForm({ ...EMPTY });
      setEditingId(null);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function edit(p: ProfileRow) {
    setEditingId(p.id);
    setForm({
      name: p.name, brand: p.brand, source: p.source, encoding: p.encoding,
      header_skip: String(p.header_skip), col_date: String(p.col_date),
      col_payee: String(p.col_payee), col_amount: String(p.col_amount),
      col_memo: p.col_memo == null ? "" : String(p.col_memo),
      amount_sign: p.amount_sign,
      filter_col: p.filter_col == null ? "" : String(p.filter_col),
      filter_value: p.filter_value ?? "",
      date_year_hint: p.date_year_hint == null ? "" : String(p.date_year_hint),
      account_default: p.account_default ?? "",
      detect_keywords: p.detect_keywords ? (JSON.parse(p.detect_keywords) as string[]).join(", ") : "",
    });
  }

  async function remove(id: number) {
    await fetch(`/v1/statement-profiles/${id}`, { method: "DELETE" });
    if (editingId === id) { setEditingId(null); setForm({ ...EMPTY }); }
    await load();
  }

  if (loading) return <p>loading…</p>;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div>
      <h2>明細プロファイル (クレカ外部登録)</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.82rem", marginTop: "-0.4rem" }}>
        他社カードの CSV 列マッピングを登録すると、 import 時に自動判定 (detect キーワード) または brand 指定で取り込めます。
        UFJ / SMBC は組込済なので登録不要。 列番号は 0 始まり。
      </p>

      <section className="last-capture" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "grid", gap: "0.4rem", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", fontSize: "0.82rem" }}>
          <label>表示名 <input type="text" value={form.name} onChange={set("name")} placeholder="楽天カード" /></label>
          <label>brand (英小文字) <input type="text" value={form.brand} onChange={set("brand")} placeholder="rakuten" /></label>
          <label>source
            <select value={form.source} onChange={set("source")}>
              <option value="credit-card">credit-card</option>
              <option value="bank">bank</option>
              <option value="amazon">amazon</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <label>文字コード
            <select value={form.encoding} onChange={set("encoding")}>
              <option value="auto">auto</option>
              <option value="shift_jis">shift_jis</option>
              <option value="utf-8">utf-8</option>
            </select>
          </label>
          <label>ヘッダ行数 <input type="number" value={form.header_skip} onChange={set("header_skip")} /></label>
          <label>日付列 <input type="number" value={form.col_date} onChange={set("col_date")} /></label>
          <label>店名列 <input type="number" value={form.col_payee} onChange={set("col_payee")} /></label>
          <label>金額列 <input type="number" value={form.col_amount} onChange={set("col_amount")} /></label>
          <label>メモ列 (任意) <input type="number" value={form.col_memo} onChange={set("col_memo")} /></label>
          <label>金額符号
            <select value={form.amount_sign} onChange={set("amount_sign")}>
              <option value="out">out (出金)</option>
              <option value="in">in (入金)</option>
              <option value="signed">signed (符号判定)</option>
            </select>
          </label>
          <label>行フィルタ列 (任意) <input type="number" value={form.filter_col} onChange={set("filter_col")} /></label>
          <label>行フィルタ値 (任意) <input type="text" value={form.filter_value} onChange={set("filter_value")} placeholder="確定" /></label>
          <label>補完年 (任意) <input type="number" value={form.date_year_hint} onChange={set("date_year_hint")} placeholder="2025" /></label>
          <label>既定 account (任意) <input type="text" value={form.account_default} onChange={set("account_default")} /></label>
          <label style={{ gridColumn: "1 / -1" }}>自動判定キーワード (カンマ区切り)
            <input type="text" value={form.detect_keywords} onChange={set("detect_keywords")} placeholder="利用店名, 楽天カード" />
          </label>
        </div>
        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
          <button className="btn" onClick={() => void save()}>{editingId ? "更新" : "+ 登録"}</button>
          {editingId && <button className="btn" onClick={() => { setEditingId(null); setForm({ ...EMPTY }); }}>キャンセル</button>}
        </div>
      </section>

      {err && <p className="error">{err}</p>}

      <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th style={{ textAlign: "left", padding: "0.3rem" }}>名前</th>
            <th style={{ textAlign: "left", padding: "0.3rem" }}>brand</th>
            <th style={{ textAlign: "left", padding: "0.3rem" }}>source</th>
            <th style={{ textAlign: "left", padding: "0.3rem" }}>列 (日/店/金)</th>
            <th style={{ textAlign: "left", padding: "0.3rem" }}>判定</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "0.3rem" }}>{p.name}</td>
              <td style={{ padding: "0.3rem" }}><code>{p.brand}</code></td>
              <td style={{ padding: "0.3rem" }}>{p.source}</td>
              <td style={{ padding: "0.3rem" }}>{p.col_date}/{p.col_payee}/{p.col_amount}</td>
              <td style={{ padding: "0.3rem", color: "var(--muted)" }}>
                {p.detect_keywords ? (JSON.parse(p.detect_keywords) as string[]).join(", ") : "—"}
              </td>
              <td style={{ padding: "0.3rem", whiteSpace: "nowrap" }}>
                <button className="btn" onClick={() => edit(p)} style={{ marginRight: 4 }}>編集</button>
                <button className="btn" onClick={() => void remove(p.id)}>削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p style={{ color: "var(--muted)", marginTop: "0.5rem" }}>まだ登録なし (UFJ/SMBC は組込済)</p>}
    </div>
  );
}
