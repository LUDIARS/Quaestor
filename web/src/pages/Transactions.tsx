import { useEffect, useMemo, useState } from "react";
import { MonthTabs, currentYear, currentMonth, monthRange } from "../components/MonthTabs.js";

interface TxRow {
  id: string;
  date: string;
  amount_in: number | null;
  amount_out: number | null;
  currency: string;
  fx_amount: number | null;
  fx_currency: string | null;
  description: string;
  payee: string | null;
  source: string;
  account: string | null;
  metadata: string | null;
}

interface ListRes {
  items: TxRow[];
  total: number;
  limit: number;
  offset: number;
}

type ViewMode = "all" | "credit-card" | "bank" | "amazon";
type BankFilter = "both" | "in" | "out";

export function Transactions() {
  const initYear = currentYear();
  const initMonth = currentMonth();
  const initRange = monthRange(initYear, initMonth);

  const [data, setData] = useState<ListRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [year, setYear] = useState(initYear);
  const [month, setMonth] = useState(initMonth);
  const [from, setFrom] = useState(initRange.date_from);
  const [to, setTo] = useState(initRange.date_to);
  const [payee, setPayee] = useState("");
  const [view, setView] = useState<ViewMode>("all");
  const [bankFilter, setBankFilter] = useState<BankFilter>("both");

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("date_from", from);
      if (to) params.set("date_to", to);
      if (payee) params.set("payee_like", payee);
      if (view !== "all") params.set("source", view);
      params.set("limit", "500");
      const j = await (await fetch(`/v1/transactions?${params}`)).json() as ListRes;
      setData(j);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view, from, to]);

  function handleMonthChange(m: string, range: { date_from: string; date_to: string }) {
    setMonth(m);
    setFrom(range.date_from);
    setTo(range.date_to);
  }

  function handleYearChange(y: string) {
    setYear(y);
    const range = monthRange(y, month);
    setFrom(range.date_from);
    setTo(range.date_to);
  }

  const filteredItems = useMemo(() => {
    if (!data) return [];
    let items = [...data.items].sort((a, b) => a.date.localeCompare(b.date));
    if (view === "bank") {
      if (bankFilter === "in") items = items.filter((t) => t.amount_in != null && t.amount_in > 0);
      if (bankFilter === "out") items = items.filter((t) => t.amount_out != null && t.amount_out > 0);
    }
    return items;
  }, [data, view, bankFilter]);

  return (
    <div>
      <h2>Transactions</h2>

      <MonthTabs
        year={year}
        month={month}
        onYearChange={handleYearChange}
        onChange={handleMonthChange}
      />

      <div className="flex gap-1 mb-3 border-b border-border">
        {(["all", "credit-card", "bank", "amazon"] as ViewMode[]).map((m) => (
          <button
            key={m}
            className="fd-tab"
            data-active={view === m}
            onClick={() => setView(m)}
          >
            {m}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem", fontSize: "0.85rem", alignItems: "center" }}>
        <label>from <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>payee <input type="text" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="部分一致" /></label>
        <button className="btn secondary" onClick={() => void load()}>絞込</button>
        {view === "bank" && (
          <span style={{ marginLeft: "1rem" }}>
            {(["both", "in", "out"] as BankFilter[]).map((f) => (
              <label key={f} style={{ marginLeft: "0.5rem" }}>
                <input type="radio" checked={bankFilter === f} onChange={() => setBankFilter(f)} />
                {f === "in" ? "入金のみ" : f === "out" ? "出金のみ" : "両方"}
              </label>
            ))}
          </span>
        )}
      </div>

      {loading && <p>loading…</p>}
      {err && <p className="error">{err}</p>}
      {data && (
        <>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            shown: {filteredItems.length} / {data.total.toLocaleString()}
          </p>
          {view === "credit-card" ? <CreditCardView items={filteredItems} /> : <FlatTable items={filteredItems} />}
        </>
      )}
    </div>
  );
}

function CreditCardView({ items }: { items: TxRow[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, TxRow[]>();
    for (const t of items) {
      const key = `${t.date}__${t.account ?? ""}`;
      const g = m.get(key);
      if (g) g.push(t); else m.set(key, [t]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const [opens, setOpens] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpens((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  return (
    <div>
      {groups.map(([key, rows]) => {
        const total = rows.reduce((s, r) => s + (r.amount_out ?? 0), 0);
        const open = opens.has(key);
        const [date, account] = key.split("__");
        return (
          <div key={key} className="last-capture" style={{ padding: "0.5rem 0.75rem" }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(key)}
              onKeyDown={(e) => { if (e.key === "Enter") toggle(key); }}
              style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}
            >
              <span style={{ width: 18, color: "var(--muted)" }}>{open ? "▾" : "▸"}</span>
              <strong style={{ width: 120 }}>{date}</strong>
              <span style={{ color: "var(--muted)" }}>{account || "-"}</span>
              <span style={{ marginLeft: "auto", fontFamily: "monospace" }}>
                {rows.length} 件 / ¥{total.toLocaleString()}
              </span>
            </div>
            {open && <TxDetailList rows={rows} />}
          </div>
        );
      })}
      {groups.length === 0 && <p style={{ color: "var(--muted)" }}>該当なし</p>}
    </div>
  );
}

interface AmazonLinkResponse {
  transaction_id: string;
  candidates: {
    transaction: TxRow;
    items: { product: string; total_owed: number; qty: number }[];
    order_id: string | null;
    ship_date: string | null;
    confidence: number;
    date_diff_days: number;
    amount_diff: number;
  }[];
}

function TxDetailList({ rows }: { rows: TxRow[] }) {
  return (
    <table style={{ width: "100%", marginTop: "0.5rem", fontSize: "0.8rem", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: "1px solid var(--border)" }}>
          <th style={{ textAlign: "left", padding: "0.3rem" }}>payee</th>
          <th style={{ textAlign: "right", padding: "0.3rem" }}>amount</th>
          <th style={{ textAlign: "left", padding: "0.3rem" }}>fx</th>
          <th style={{ textAlign: "left", padding: "0.3rem" }}>desc</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => <CcDetailRow key={t.id} t={t} />)}
      </tbody>
    </table>
  );
}

function CcDetailRow({ t }: { t: TxRow }) {
  const isAmazon = /AMAZON|ＡＭＡＺＯＮ|Ａｍａｚｏｎ/i.test(t.payee ?? "") || /AMAZON|ＡＭＡＺＯＮ/i.test(t.description);
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<AmazonLinkResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchLink() {
    if (link) return;
    setLoading(true);
    try {
      const j = await (await fetch(`/v1/transactions/${t.id}/amazon-link`)).json() as AmazonLinkResponse;
      setLink(j);
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && isAmazon && !link) void fetchLink();
  }

  return (
    <>
      <tr
        style={{ borderBottom: "1px dotted var(--border)", cursor: isAmazon ? "pointer" : "default" }}
        onClick={isAmazon ? toggle : undefined}
        title={isAmazon ? "クリックで Amazon Order を展開" : ""}
      >
        <td style={{ padding: "0.3rem" }}>
          {isAmazon && <span style={{ marginRight: 4, color: "var(--c-accent)" }}>{open ? "▾" : "▸"}</span>}
          {t.payee ?? "-"}
        </td>
        <td style={{ padding: "0.3rem", textAlign: "right", color: "var(--danger)" }}>
          ¥{t.amount_out?.toLocaleString() ?? "-"}
        </td>
        <td style={{ padding: "0.3rem", color: "var(--muted)" }}>
          {t.fx_amount && t.fx_currency ? `${t.fx_amount} ${t.fx_currency}` : ""}
        </td>
        <td style={{ padding: "0.3rem", color: "var(--muted)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
          {t.description}
        </td>
      </tr>
      {open && isAmazon && (
        <tr>
          <td colSpan={4} style={{ padding: "0.5rem 1.5rem", background: "var(--c-bg)" }}>
            {loading && <span className="text-subtle">loading…</span>}
            {!loading && link && link.candidates.length === 0 && (
              <span className="text-subtle">対応する Amazon Order が見つからない (前後 3 日 / 金額 ±3%)</span>
            )}
            {!loading && link && link.candidates.length > 0 && (
              <div>
                {link.candidates.map((c, idx) => (
                  <div key={c.transaction.id} style={{ marginBottom: "0.5rem", paddingBottom: "0.4rem", borderBottom: idx < link.candidates.length - 1 ? "1px dashed var(--border)" : "none" }}>
                    <div className="text-xs text-subtle" style={{ marginBottom: 3 }}>
                      <span className={`fd-badge ${c.confidence >= 0.85 ? "fd-badge-ok" : c.confidence >= 0.5 ? "fd-badge-warn" : "fd-badge-muted"}`}>
                        {(c.confidence * 100).toFixed(0)}%
                      </span>
                      {" "} order: <code>{c.order_id ?? "-"}</code> | ship: {c.ship_date ?? "-"} |
                      Δ {c.date_diff_days}日 ¥{c.amount_diff.toLocaleString()}
                    </div>
                    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                      {c.items.map((it, i) => (
                        <li key={i} style={{ display: "flex", gap: "0.5rem", padding: "0.15rem 0" }}>
                          <span style={{ flex: 1 }}>{it.product}</span>
                          {it.qty > 1 && <span className="text-subtle">×{it.qty}</span>}
                          <span className="font-mono">¥{it.total_owed.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function FlatTable({ items }: { items: TxRow[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <thead>
        <tr style={{ borderBottom: "1px solid var(--border)" }}>
          <th style={{ textAlign: "left", padding: "0.4rem" }}>date</th>
          <th style={{ textAlign: "left", padding: "0.4rem" }}>payee</th>
          <th style={{ textAlign: "right", padding: "0.4rem" }}>out</th>
          <th style={{ textAlign: "right", padding: "0.4rem" }}>in</th>
          <th style={{ textAlign: "left", padding: "0.4rem" }}>account</th>
          <th style={{ textAlign: "left", padding: "0.4rem" }}>source</th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
            <td style={{ padding: "0.4rem" }}>{t.date}</td>
            <td style={{ padding: "0.4rem" }}>{t.payee ?? t.description}</td>
            <td style={{ padding: "0.4rem", textAlign: "right", color: t.amount_out ? "var(--danger)" : "var(--muted)" }}>
              {t.amount_out != null ? `¥${t.amount_out.toLocaleString()}` : ""}
              {t.fx_amount && t.fx_currency ? <span style={{ color: "var(--muted)", marginLeft: 4 }}>({t.fx_amount} {t.fx_currency})</span> : null}
            </td>
            <td style={{ padding: "0.4rem", textAlign: "right", color: t.amount_in ? "var(--ok)" : "var(--muted)" }}>
              {t.amount_in != null ? `¥${t.amount_in.toLocaleString()}` : ""}
            </td>
            <td style={{ padding: "0.4rem", color: "var(--muted)" }}>{t.account ?? "-"}</td>
            <td style={{ padding: "0.4rem", color: "var(--muted)" }}>{t.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
