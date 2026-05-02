import { useEffect, useState } from "react";

export interface YearRange {
  /** ISO yyyy-mm-dd */
  date_from: string;
  /** ISO yyyy-mm-dd */
  date_to: string;
}

interface Props {
  /** 選択中の年。 "all" は期間フィルタなし */
  value: string;
  onChange: (year: string, range: YearRange | null) => void;
  /** 表示する固定 fallback (DB に年データが無いときも見せたい年) */
  fallback?: string[];
  /** all タブを出すか (default true) */
  showAll?: boolean;
}

/**
 * /v1/dashboard/years から取得した年タブを表示。
 * クリックで onChange(year, {date_from, date_to}) を呼ぶ。
 */
export function YearTabs({ value, onChange, fallback, showAll = true }: Props) {
  const [years, setYears] = useState<string[]>([]);

  useEffect(() => {
    fetch("/v1/dashboard/years")
      .then((r) => r.json() as Promise<{ years: string[] }>)
      .then((j) => {
        const merged = Array.from(new Set([...(j.years ?? []), ...(fallback ?? [])]))
          .sort((a, b) => b.localeCompare(a));
        setYears(merged);
      })
      .catch(() => setYears(fallback ?? []));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  function pick(y: string) {
    if (y === "all") onChange("all", null);
    else onChange(y, { date_from: `${y}-01-01`, date_to: `${y}-12-31` });
  }

  const tabs: string[] = showAll ? ["all", ...years] : years;
  return (
    <div className="flex gap-1 border-b border-border mb-3">
      {tabs.map((y) => (
        <button
          key={y}
          className="fd-tab"
          data-active={value === y}
          onClick={() => pick(y)}
        >
          {y === "all" ? "全期間" : `${y}年`}
        </button>
      ))}
      {tabs.length === 0 && (
        <span className="text-xs text-subtle px-3 py-1.5">データなし</span>
      )}
    </div>
  );
}

/** 現在年を yyyy で返す */
export function currentYear(): string {
  return new Date().getUTCFullYear().toString();
}
