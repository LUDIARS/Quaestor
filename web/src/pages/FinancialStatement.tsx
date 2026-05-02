import { useEffect, useState } from "react";
import { YearTabs, currentYear } from "../components/YearTabs.js";

interface FsRow {
  id: number;
  year: number;
  section: string;
  label: string;
  amount: number | null;
  display_order: number;
  metadata: string | null;
  source: "manual" | "imported" | "computed";
}

interface FsRes {
  year: number;
  sections: Record<string, FsRow[]>;
}

const SECTION_ORDER = ["summary", "pl", "monthly_sales", "bs_assets", "bs_liabilities"];
const SECTION_LABEL: Record<string, string> = {
  summary: "家計サマリ",
  pl: "損益計算書 (P&L)",
  monthly_sales: "月別売上",
  bs_assets: "貸借対照表 — 資産の部",
  bs_liabilities: "貸借対照表 — 負債・資本の部",
};

/** summary section をカテゴリ別 (収入 / 税金 / 社保 / 生活費 / 投資 / 貯蓄 / その他) にグルーピング */
function groupSummary(rows: FsRow[]): Array<{ title: string; items: FsRow[] }> {
  const income: FsRow[] = [];
  const tax: FsRow[] = [];
  const social: FsRow[] = [];
  const living: FsRow[] = [];
  const invest: FsRow[] = [];
  const saving: FsRow[] = [];
  const other: FsRow[] = [];
  for (const r of rows) {
    const l = r.label;
    if (/貯蓄/.test(l)) saving.push(r);
    else if (/売上|収入|配偶者|バンタン|児童手当|利息|世帯/.test(l)) income.push(r);
    else if (/^税金|所得税|住民税|消費税|国税|ふるさと|国民健康保険/.test(l)) tax.push(r);
    else if (/^社会保険|年金/.test(l)) social.push(r);
    else if (/生活費|ATM|ガス|電話|保育園/.test(l)) living.push(r);
    else if (/投資|SBI|外貨/.test(l)) invest.push(r);
    else other.push(r);
  }
  const groups: Array<{ title: string; items: FsRow[] }> = [];
  if (income.length) groups.push({ title: "収入", items: income });
  if (tax.length) groups.push({ title: "税金内訳", items: tax });
  if (social.length) groups.push({ title: "社会保険・年金", items: social });
  if (living.length) groups.push({ title: "生活費内訳", items: living });
  if (invest.length) groups.push({ title: "投資", items: invest });
  if (saving.length) groups.push({ title: "貯蓄", items: saving });
  if (other.length) groups.push({ title: "事業経費・支出合計・その他", items: other });
  return groups;
}

export function FinancialStatement() {
  const [year, setYear] = useState(currentYear());
  const [data, setData] = useState<FsRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const j = await (await fetch(`/v1/financial-statement/${year}`)).json() as FsRes;
      setData(j);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [year]);

  async function recompute() {
    await fetch(`/v1/financial-statement/${year}/recompute`, { method: "POST" });
    await load();
  }

  return (
    <div>
      <h2>決算書 (Financial Statement)</h2>
      <p className="text-sm text-subtle mb-3">
        年度別の損益計算書 / 貸借対照表 / 月別売上 / 家計サマリ。 2025 年は計算書 xlsx 取込値、 他年度は transactions / invoices からの計算値。
      </p>

      <YearTabs value={year} onChange={(y) => setYear(y === "all" ? currentYear() : y)} showAll={false} />

      <div className="flex items-center gap-2 mb-4">
        <button className="fd-btn-secondary" onClick={() => void recompute()}>再計算 (transactions / invoices ベース)</button>
        {loading && <span className="text-subtle text-sm">loading…</span>}
        {err && <span className="error">{err}</span>}
      </div>

      {data && SECTION_ORDER.map((sec) => {
        const rows = data.sections[sec];
        if (!rows || rows.length === 0) return null;
        return (
          <section key={sec} className="fd-section mb-4">
            <h3 className="text-base font-semibold mb-2">
              {SECTION_LABEL[sec] ?? sec}
              <span className="ml-2 text-xs text-subtle">{rows.length} 件 / source: {[...new Set(rows.map((r) => r.source))].join(", ")}</span>
            </h3>
            {sec === "monthly_sales"
              ? <MonthlySalesTable rows={rows} />
              : sec.startsWith("bs_")
                ? <BsTable rows={rows} />
                : sec === "summary"
                  ? <SummaryGrouped rows={rows} />
                  : <FlatLabeledTable rows={rows} />}
          </section>
        );
      })}

      {data && Object.keys(data.sections).length === 0 && (
        <p className="text-subtle">データなし。 「再計算」 で transactions から作成。</p>
      )}
    </div>
  );
}

function FlatLabeledTable({ rows, highlightLabels }: { rows: FsRow[]; highlightLabels?: string[] }) {
  const set = new Set(highlightLabels ?? []);
  return (
    <table className="fd-table">
      <thead>
        <tr>
          <th className="w-2/3">科目</th>
          <th className="text-right">金額</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={set.has(r.label) ? "font-semibold" : ""}>
            <td>{r.label}</td>
            <td className="text-right font-mono">{r.amount != null ? `¥${r.amount.toLocaleString()}` : "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** summary section をカテゴリ別にサブセクション + 小計付きで表示 */
function SummaryGrouped({ rows }: { rows: FsRow[] }) {
  const groups = groupSummary(rows);
  return (
    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
      {groups.map((g) => {
        const subtotal = g.items.reduce((s, r) => s + (r.amount ?? 0), 0);
        return (
          <div key={g.title} className="fd-card">
            <div className="text-sm font-semibold mb-1 flex justify-between items-baseline">
              <span>{g.title}</span>
              <span className="font-mono text-xs text-subtle">¥{subtotal.toLocaleString()}</span>
            </div>
            <table className="fd-table" style={{ fontSize: "0.8rem" }}>
              <tbody>
                {g.items.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1">{r.label}</td>
                    <td className="py-1 text-right font-mono">{r.amount != null ? `¥${r.amount.toLocaleString()}` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function MonthlySalesTable({ rows }: { rows: FsRow[] }) {
  const total = rows.find((r) => /計$/.test(r.label));
  return (
    <table className="fd-table">
      <thead>
        <tr>
          <th>月</th>
          <th className="text-right">売上 (発生主義)</th>
        </tr>
      </thead>
      <tbody>
        {rows.filter((r) => r !== total).map((r) => (
          <tr key={r.id}>
            <td>{r.label}</td>
            <td className="text-right font-mono">¥{(r.amount ?? 0).toLocaleString()}</td>
          </tr>
        ))}
        {total && (
          <tr className="font-semibold border-t-2 border-accent">
            <td>{total.label}</td>
            <td className="text-right font-mono">¥{(total.amount ?? 0).toLocaleString()}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function BsTable({ rows }: { rows: FsRow[] }) {
  return (
    <table className="fd-table">
      <thead>
        <tr>
          <th>科目</th>
          <th className="text-right">期首</th>
          <th className="text-right">期末</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          let opening: number | null = null;
          let closing: number | null = null;
          try {
            const m = r.metadata ? JSON.parse(r.metadata) : null;
            opening = m?.opening ?? null;
            closing = m?.closing ?? r.amount;
          } catch {}
          const isTotal = /合計/.test(r.label);
          return (
            <tr key={r.id} className={isTotal ? "font-semibold border-t-2 border-accent" : ""}>
              <td>{r.label}</td>
              <td className="text-right font-mono text-subtle">{opening != null ? `¥${opening.toLocaleString()}` : "-"}</td>
              <td className="text-right font-mono">{closing != null ? `¥${closing.toLocaleString()}` : "-"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
