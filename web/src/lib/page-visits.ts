/** ページ訪問回数 (端末内、 localStorage)。 スマホトップの「よく使うページ」に使う。
 * @implements SPEC-MOBILE-HOME-002 (spec/feature/mobile-home.md) */

import { DEFAULT_FREQUENT, isPage, type Page } from "./pages.js";

const KEY = "quaestor.page-visits.v1";

interface Visit { count: number; last: number }
type Visits = Partial<Record<Page, Visit>>;

function read(): Visits {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Visit>;
    const out: Visits = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isPage(k)
        && Number.isSafeInteger(v?.count) && v.count >= 0
        && Number.isSafeInteger(v?.last) && v.last >= 0) out[k] = v;
    }
    return out;
  } catch { /* localStorage が使えない環境 (プライベートモード等) は履歴無しとして扱う */ return {}; }
}

function write(v: Visits): void {
  try { localStorage.setItem(KEY, JSON.stringify(v)); }
  catch { /* 保存できなくても画面は動かす (端末ごとの便宜なので失っても困らない) */ }
}

export function recordVisit(page: Page, now = Date.now()): void {
  if (page === "dashboard") return; // トップ自体は数えない
  const v = read();
  const cur = v[page] ?? { count: 0, last: 0 };
  v[page] = { count: cur.count + 1, last: now };
  write(v);
}

/** 回数降順 → 最終訪問降順で上位 n 件。 履歴が無ければ既定。 */
export function frequentPages(n = 6): Page[] {
  const v = read();
  const ranked = (Object.entries(v) as [Page, Visit][])
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .map(([k]) => k);
  const merged = [...ranked, ...DEFAULT_FREQUENT.filter((p) => !ranked.includes(p))];
  return merged.slice(0, n);
}
