import { useEffect, useState } from "react";
import { NAV_SECTIONS, PAGES, type Page } from "../lib/pages.js";

/**
 * Concordia の Nav (web/src/components/Nav.tsx) を page state 版に移植。
 * PC: 左サイドバー (折りたたみ可)。 スマホ: ☰ からのドロワー。
 * @implements SPEC-MOBILE-HOME-001 (spec/feature/mobile-home.md)
 */

const COLLAPSED_KEY = "quaestor.sidebar.collapsed.v1";

interface Props {
  page: Page;
  onSelect: (page: Page) => void;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}

export function Nav({ page, onSelect, mobileOpen, onMobileOpenChange }: Props) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed());

  useEffect(() => { onMobileOpenChange(false); }, [page, onMobileOpenChange]);
  useEffect(() => {
    if (!mobileOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onMobileOpenChange(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [mobileOpen, onMobileOpenChange]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      try { localStorage.setItem(COLLAPSED_KEY, value ? "0" : "1"); } catch { /* 端末ごとの便宜、 保存失敗は無視 */ }
      return !value;
    });
  };

  const renderLinks = (isCollapsed: boolean, closeAfterSelect = false) => (
    <>
      {NAV_SECTIONS.map((section) => (
        <section key={section} className="mb-5">
          {!isCollapsed && <h2 className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{section}</h2>}
          <ul className="space-y-0.5">
            {PAGES.filter((item) => item.section === section).map((item) => {
              const active = page === item.key;
              return (
                <li key={item.key}>
                  <a
                    href={`#${item.key}`}
                    title={isCollapsed ? item.label : undefined}
                    aria-label={isCollapsed ? item.label : undefined}
                    aria-current={active ? "page" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      onSelect(item.key);
                      if (closeAfterSelect) onMobileOpenChange(false);
                    }}
                    className={`block rounded px-3 py-2 text-sm no-underline ${active ? "bg-muted text-accent" : "text-subtle hover:bg-muted hover:text-text"}`}
                  >
                    {isCollapsed ? item.label.slice(0, 1) : item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="presentation">
          <button type="button" className="absolute inset-0 bg-black/50" aria-label="メニューを閉じる" onClick={() => onMobileOpenChange(false)} />
          <nav className="absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-border bg-surface p-3 shadow-xl" aria-label="メインメニュー">
            <div className="mb-5 flex items-center justify-between">
              <span className="font-semibold"><span className="text-accent">●</span> Quaestor</span>
              <button type="button" className="px-2 text-xl text-subtle" aria-label="メニューを閉じる" onClick={() => onMobileOpenChange(false)}>×</button>
            </div>
            {renderLinks(false, true)}
          </nav>
        </div>
      )}
      <nav
        aria-label="メインメニュー"
        className={`hidden md:flex shrink-0 flex-col border-r border-border bg-surface p-3 transition-[width] ${collapsed ? "w-16" : "w-56"}`}
      >
        <button type="button" className="mb-4 self-end rounded px-2 py-1 text-subtle hover:bg-muted" aria-label={collapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"} onClick={toggleCollapsed}>
          {collapsed ? "›" : "‹"}
        </button>
        {renderLinks(collapsed)}
      </nav>
    </>
  );
}
