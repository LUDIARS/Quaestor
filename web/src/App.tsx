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

type Page =
  | "dashboard"
  | "financial"
  | "bookkeeping"
  | "household"
  | "apportionment-sheet"
  | "business-plan"
  | "subsidies"
  | "scan"
  | "receipts"
  | "imports"
  | "profiles"
  | "transactions"
  | "reconcile"
  | "invoices"
  | "invest"
  | "portfolio"
  | "export"
  | "settings";

const PAGES: { key: Page; label: string }[] = [
  { key: "dashboard", label: "dashboard" },
  { key: "financial", label: "決算書" },
  { key: "bookkeeping", label: "簿記" },
  { key: "household", label: "家計分析" },
  { key: "apportionment-sheet", label: "按分シート" },
  { key: "business-plan", label: "事業計画" },
  { key: "subsidies", label: "補助金" },
  { key: "scan", label: "scan" },
  { key: "receipts", label: "receipts" },
  { key: "imports", label: "imports" },
  { key: "profiles", label: "明細プロファイル" },
  { key: "transactions", label: "transactions" },
  { key: "reconcile", label: "reconcile" },
  { key: "invoices", label: "invoices" },
  { key: "invest", label: "投資/優待" },
  { key: "portfolio", label: "積立/資産" },
  { key: "export", label: "export" },
  { key: "settings", label: "設定" },
];

const UNAVAILABLE_VERSION = "unavailable";

/** @implements SPEC-RUNTIME-VERSION-001 (spec/feature/runtime-version.md) */
export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [runtimeVersion, setRuntimeVersion] = useState(UNAVAILABLE_VERSION);

  useEffect(() => {
    void fetch("/health")
      .then((response) => response.ok ? response.json() as Promise<{ version?: unknown }> : undefined)
      .then((health) => {
        if (typeof health?.version === "string" && health.version) setRuntimeVersion(health.version);
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="app">
      <header>
        <h1>Quaestor <span className="runtime-version">v{runtimeVersion}</span></h1>
        <nav>
          {PAGES.map((p) => (
            <a key={p.key} href={`#${p.key}`} onClick={(e) => { e.preventDefault(); setPage(p.key); }} aria-current={page === p.key}>
              {p.label}
            </a>
          ))}
        </nav>
      </header>
      {page === "dashboard" && <Dashboard />}
      {page === "financial" && <FinancialStatement />}
      {page === "bookkeeping" && <Bookkeeping />}
      {page === "household" && <HouseholdAnalysis />}
      {page === "apportionment-sheet" && <ApportionmentSheet />}
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
    </div>
  );
}
