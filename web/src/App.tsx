import { useEffect, useState } from "react";
import { Scan } from "./pages/Scan.js";
import { Receipts } from "./pages/Receipts.js";
import { Imports } from "./pages/Imports.js";
import { Transactions } from "./pages/Transactions.js";
import { Reconcile } from "./pages/Reconcile.js";
import { ExportPage } from "./pages/ExportPage.js";
import { Invoices } from "./pages/Invoices.js";
import { Dashboard } from "./pages/Dashboard.js";
import { FinancialStatement } from "./pages/FinancialStatement.js";
import { Invest } from "./pages/Invest.js";
import { Portfolio } from "./pages/Portfolio.js";
import { StatementProfiles } from "./pages/StatementProfiles.js";
import { BusinessPlan } from "./pages/BusinessPlan.js";
import { Subsidies } from "./pages/Subsidies.js";
import { Settings } from "./pages/Settings.js";
import { Bookkeeping } from "./pages/Bookkeeping.js";
import { HouseholdAnalysis } from "./pages/HouseholdAnalysis.js";
import { ApportionmentSheet } from "./pages/ApportionmentSheet.js";
import { Depreciation } from "./pages/Depreciation.js";
import { MobileHome } from "./pages/MobileHome.js";
import { CostStructure } from "./pages/CostStructure.js";
import { Nav } from "./components/Nav.js";
import { isPage, pageLabel, type Page } from "./lib/pages.js";
import { recordVisit } from "./lib/page-visits.js";
import { MOBILE_QUERY, useMediaQuery } from "./lib/useMediaQuery.js";

const UNAVAILABLE_VERSION = "unavailable";

function initialPage(): Page {
  const hash = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
  return isPage(hash) ? hash : "dashboard";
}

/**
 * @implements SPEC-RUNTIME-VERSION-001 (spec/feature/runtime-version.md)
 * @implements SPEC-DEPRECIATION-003 (spec/feature/depreciation.md)
 * @implements SPEC-MOBILE-HOME-001 (spec/feature/mobile-home.md)
 */
export function App() {
  const [page, setPageState] = useState<Page>(() => initialPage());
  const [menuOpen, setMenuOpen] = useState(false);
  const [runtimeVersion, setRuntimeVersion] = useState(UNAVAILABLE_VERSION);
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const setPage = (p: Page) => {
    setPageState(p);
    recordVisit(p);
    try { window.history.replaceState(null, "", `#${p}`); } catch { /* history が使えない埋め込み環境は無視 */ }
  };

  useEffect(() => {
    void fetch("/health")
      .then((response) => response.ok ? response.json() as Promise<{ version?: unknown }> : undefined)
      .then((health) => {
        if (typeof health?.version === "string" && health.version) setRuntimeVersion(health.version);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isMobile) setMenuOpen(false);
  }, [isMobile]);

  const showMobileHome = isMobile && page === "dashboard";

  return (
    <div className="app-shell min-h-screen flex flex-col">
      <header className="border-b border-border bg-surface px-3 sm:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          className="md:hidden rounded border border-border px-2 py-1 text-subtle"
          aria-label="メニューを開く"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          ☰
        </button>
        <span className="text-lg font-semibold whitespace-nowrap">
          <span className="text-accent">●</span> Quaestor <span className="runtime-version">v{runtimeVersion}</span>
        </span>
        <span className="text-subtle text-xs hidden md:inline">personal accounting</span>
        {page !== "dashboard" && <span className="ml-auto text-sm text-subtle md:hidden">{pageLabel(page)}</span>}
      </header>
      <div className="flex min-h-0 flex-1">
        <Nav page={page} onSelect={setPage} mobileOpen={menuOpen} onMobileOpenChange={setMenuOpen} />
        <main className="min-w-0 flex-1 px-3 sm:px-6 py-4">
          {showMobileHome && <MobileHome onSelect={setPage} onOpenMenu={() => setMenuOpen(true)} />}
          {!showMobileHome && page === "dashboard" && <Dashboard />}
          {page === "financial" && <FinancialStatement />}
          {page === "bookkeeping" && <Bookkeeping />}
          {page === "household" && <HouseholdAnalysis />}
          {page === "cost-structure" && <CostStructure />}
          {page === "apportionment-sheet" && <ApportionmentSheet />}
          {page === "depreciation" && <Depreciation />}
          {page === "business-plan" && <BusinessPlan />}
          {page === "subsidies" && <Subsidies />}
          {page === "scan" && <Scan />}
          {page === "receipts" && <Receipts />}
          {page === "imports" && <Imports />}
          {page === "profiles" && <StatementProfiles />}
          {page === "transactions" && <Transactions />}
          {page === "reconcile" && <Reconcile />}
          {page === "invoices" && <Invoices />}
          {page === "invest" && <Invest />}
          {page === "portfolio" && <Portfolio />}
          {page === "export" && <ExportPage />}
          {page === "settings" && <Settings />}
        </main>
      </div>
    </div>
  );
}
