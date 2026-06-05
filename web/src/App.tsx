import { useState } from "react";
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

type Page =
  | "dashboard"
  | "financial"
  | "scan"
  | "receipts"
  | "imports"
  | "transactions"
  | "reconcile"
  | "invoices"
  | "invest"
  | "export";

const PAGES: { key: Page; label: string }[] = [
  { key: "dashboard", label: "dashboard" },
  { key: "financial", label: "決算書" },
  { key: "scan", label: "scan" },
  { key: "receipts", label: "receipts" },
  { key: "imports", label: "imports" },
  { key: "transactions", label: "transactions" },
  { key: "reconcile", label: "reconcile" },
  { key: "invoices", label: "invoices" },
  { key: "invest", label: "投資/優待" },
  { key: "export", label: "export" },
];

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  return (
    <div className="app">
      <header>
        <h1>Quaestor</h1>
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
      {page === "scan" && <Scan />}
      {page === "receipts" && <Receipts />}
      {page === "imports" && <Imports />}
      {page === "transactions" && <Transactions />}
      {page === "reconcile" && <Reconcile />}
      {page === "invoices" && <Invoices />}
      {page === "invest" && <Invest />}
      {page === "export" && <ExportPage />}
    </div>
  );
}
