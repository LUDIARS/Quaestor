import { useEffect, useState } from "react";
import { pageLabel, isPage, type Page } from "../lib/pages.js";
import { frequentPages } from "../lib/page-visits.js";

/** スマホのトップ: メニューボタン / よく使うページ / アクティビティログ。
 * @implements SPEC-MOBILE-HOME-002 (spec/feature/mobile-home.md) */

interface ActivityEvent { kind: string; at: number; title: string; detail: string | null; page: Page }

const KIND_ICON: Record<string, string> = {
  import: "📥", receipt_captured: "📷", receipt_committed: "🧾", reconciliation: "🔗", invoice: "📄",
  journal_manual: "✍️", journal_imported: "📗", fixed_asset: "🏷️", apportionment_rule: "⚖️",
};

function relative(unixSec: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000) - unixSec);
  if (diff < 60) return "たった今";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 時間前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 日前`;
  return new Date(unixSec * 1000).toLocaleDateString("ja-JP");
}

function isActivityEvent(value: unknown): value is ActivityEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ActivityEvent>;
  return typeof event.kind === "string"
    && Number.isSafeInteger(event.at)
    && typeof event.title === "string"
    && (event.detail === null || typeof event.detail === "string")
    && isPage(event.page);
}

export function MobileHome({ onSelect, onOpenMenu }: { onSelect: (p: Page) => void; onOpenMenu: () => void }) {
  const [frequent] = useState<Page[]>(() => frequentPages(6));
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/v1/activity?limit=30", { signal: controller.signal })
      .then(async (r) => {
        const j = await r.json() as { items?: unknown; error?: string };
        if (!r.ok) throw new Error(j.error ?? String(r.status));
        if (!Array.isArray(j.items) || !j.items.every(isActivityEvent)) {
          throw new Error("invalid activity response");
        }
        return j.items;
      })
      .then(setEvents)
      .catch((e: Error) => { if (e.name !== "AbortError") setErr(e.message); });
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onOpenMenu}
        className="w-full rounded-md border border-border bg-surface px-4 py-3 text-left text-base font-semibold"
        aria-label="メニューを開く"
      >
        ☰ メニュー
      </button>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-subtle">よく使うページ</h2>
        <ul className="grid grid-cols-2 gap-2">
          {frequent.map((p) => (
            <li key={p}>
              <a href={`#${p}`} onClick={(e) => { e.preventDefault(); onSelect(p); }}
                className="block rounded-md border border-border bg-surface px-3 py-3 text-center text-sm no-underline text-text hover:bg-muted">
                {pageLabel(p)}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-subtle">アクティビティ</h2>
        {err && <p className="error">{err}</p>}
        {events === null && !err && <p className="text-subtle">loading…</p>}
        {events && events.length === 0 && <p className="text-subtle">まだ記録がありません</p>}
        {events && events.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border bg-surface">
            {events.map((e, i) => (
              <li key={`${e.kind}-${e.at}-${i}`}>
                <a href={`#${e.page}`} onClick={(ev) => { ev.preventDefault(); onSelect(e.page); }}
                  className="flex items-start gap-3 px-3 py-2 no-underline text-text hover:bg-muted">
                  <span className="text-lg leading-6">{KIND_ICON[e.kind] ?? "•"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{e.title}</span>
                    {e.detail && <span className="block truncate text-xs text-subtle">{e.detail}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-subtle">{relative(e.at)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
