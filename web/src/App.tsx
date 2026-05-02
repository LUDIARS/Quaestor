import { useState } from "react";
import { Scan } from "./pages/Scan.js";
import { Receipts } from "./pages/Receipts.js";

type Page = "scan" | "receipts";

export function App() {
  const [page, setPage] = useState<Page>("scan");
  return (
    <div className="app">
      <header>
        <h1>Quaestor</h1>
        <nav>
          <a href="#scan" onClick={(e) => { e.preventDefault(); setPage("scan"); }} aria-current={page === "scan"}>scan</a>
          <a href="#receipts" onClick={(e) => { e.preventDefault(); setPage("receipts"); }} aria-current={page === "receipts"}>receipts</a>
        </nav>
      </header>
      {page === "scan" && <Scan />}
      {page === "receipts" && <Receipts />}
    </div>
  );
}
