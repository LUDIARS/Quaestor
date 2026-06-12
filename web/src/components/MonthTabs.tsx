import { useEffect, useState } from "react";

export interface MonthRange {
  date_from: string;
  date_to: string;
}

interface Props {
  year: string;
  month: string;
  onYearChange: (year: string) => void;
  onChange: (month: string, range: MonthRange) => void;
}

const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

function lastDayOfMonth(year: string, month: string): string {
  const d = new Date(parseInt(year), parseInt(month), 0);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function monthRange(year: string, month: string): MonthRange {
  return {
    date_from: `${year}-${month}-01`,
    date_to: lastDayOfMonth(year, month),
  };
}

export function currentYear(): string {
  return String(new Date().getFullYear());
}

export function currentMonth(): string {
  return String(new Date().getMonth() + 1).padStart(2, "0");
}

export function MonthTabs({ year, month, onYearChange, onChange }: Props) {
  const [years, setYears] = useState<string[]>([]);

  useEffect(() => {
    fetch("/v1/dashboard/years")
      .then((r) => r.json() as Promise<{ years: string[] }>)
      .then((j) => {
        const sorted = Array.from(new Set([...(j.years ?? []), currentYear()]))
          .sort((a, b) => b.localeCompare(a));
        setYears(sorted);
      })
      .catch(() => setYears([currentYear()]));
  }, []);

  function pick(m: string) {
    onChange(m, monthRange(year, m));
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
      <div className="flex gap-1 border-b border-border" style={{ flex: 1 }}>
        {MONTHS.map((m) => (
          <button
            key={m}
            className="fd-tab"
            data-active={month === m}
            onClick={() => pick(m)}
          >
            {parseInt(m)}月
          </button>
        ))}
      </div>
      <select
        value={year}
        onChange={(e) => onYearChange(e.target.value)}
        style={{ fontSize: "0.85rem", padding: "0.25rem 0.4rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--c-bg)", color: "var(--fg)", cursor: "pointer" }}
      >
        {years.map((y) => (
          <option key={y} value={y}>{y}年</option>
        ))}
      </select>
    </div>
  );
}
