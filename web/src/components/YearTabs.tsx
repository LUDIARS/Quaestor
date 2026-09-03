import { useEffect, useState } from "react";
import { MOBILE_QUERY, useMediaQuery } from "../lib/useMediaQuery.js";

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

/** スマホでタブとして並べる年数 (今年 + 過去 2 年)。それ以前はプルダウンに括る */
const MOBILE_RECENT_YEARS = 3;

/**
 * /v1/dashboard/years から取得した年タブを表示。
 * クリックで onChange(year, {date_from, date_to}) を呼ぶ。
 * スマホでは今年 + 過去 2 年のうちデータがある年をタブに、
 * それ以前 (と全期間) を「それ以前」のプルダウンに括り、横幅に収める。
 * @implements SPEC-MOBILE-HOME-003 (spec/feature/mobile-home.md)
 */
export function YearTabs({ value, onChange, fallback, showAll = true }: Props) {
  const [years, setYears] = useState<string[]>([]);
  const isMobile = useMediaQuery(MOBILE_QUERY);

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

  if (isMobile) {
    const now = Number(currentYear());
    const recentYearSet = new Set(
      Array.from({ length: MOBILE_RECENT_YEARS }, (_, i) => String(now - i)),
    );
    const recent = years.filter((y) => recentYearSet.has(y));
    const older = [...(showAll ? ["all"] : []), ...years.filter((y) => !recentYearSet.has(y))];
    const olderSelected = older.includes(value) ? value : "";
    return (
      <div className="flex gap-1 border-b border-border mb-3 items-center overflow-x-auto">
        {recent.map((y) => (
          <button
            type="button"
            key={y}
            className="fd-tab whitespace-nowrap"
            data-active={value === y}
            onClick={() => pick(y)}
          >
            {y}年
          </button>
        ))}
        {older.length > 0 && (
          <select
            className="fd-input text-sm ml-1"
            aria-label="それ以前の年"
            value={olderSelected}
            data-active={olderSelected !== ""}
            onChange={(e) => pick(e.target.value)}
          >
            <option value="" disabled>それ以前</option>
            {older.map((y) => (
              <option key={y} value={y}>{y === "all" ? "全期間" : `${y}年`}</option>
            ))}
          </select>
        )}
        {recent.length === 0 && older.length === 0 && (
          <span className="text-xs text-subtle px-3 py-1.5">データなし</span>
        )}
      </div>
    );
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
