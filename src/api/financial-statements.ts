import { Hono } from "hono";
import type { FinancialStatementsRepo, FsSection } from "../db/financial-statements-repo.js";

export interface FsApiDeps {
  repo: FinancialStatementsRepo;
}

export function financialStatementsRouter(deps: FsApiDeps): Hono {
  const app = new Hono();

  app.get("/years", (c) => c.json({ years: deps.repo.years() }));

  // GET /v1/financial-statement/:year — return all sections grouped
  app.get("/:year", (c) => {
    const y = parseInt(c.req.param("year"), 10);
    if (Number.isNaN(y)) return c.json({ error: "invalid year" }, 400);
    const rows = deps.repo.findYear(y);
    if (rows.length === 0) {
      // 取込も計算もまだ → 計算を実行 (cache-on-first-read)
      deps.repo.computeFromTransactions(y);
    }
    const fresh = deps.repo.findYear(y);
    const grouped: Record<string, typeof fresh> = {};
    for (const r of fresh) {
      if (!grouped[r.section]) grouped[r.section] = [];
      grouped[r.section]!.push(r);
    }
    return c.json({ year: y, sections: grouped });
  });

  // POST /v1/financial-statement/:year/recompute — 強制再計算 (xlsx imported は維持)
  app.post("/:year/recompute", (c) => {
    const y = parseInt(c.req.param("year"), 10);
    if (Number.isNaN(y)) return c.json({ error: "invalid year" }, 400);
    const r = deps.repo.computeFromTransactions(y);
    return c.json({ year: y, ...r });
  });

  return app;
}
