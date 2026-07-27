import type Database from "better-sqlite3";
import { Hono } from "hono";
import { z } from "zod";
import type { ApportionmentRulesRepo } from "../db/apportionment-rules-repo.js";
import { buildMemoriaSpendingLog } from "../services/memoria-spending-log.js";
import { isDirectLoopbackRequest } from "../shared/local-request.js";

const QuerySchema = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface MemoriaIntegrationApiDeps {
  db: Database.Database;
  rules: ApportionmentRulesRepo;
}

export function memoriaIntegrationRouter(deps: MemoriaIntegrationApiDeps): Hono {
  const app = new Hono();

  app.get("/spending-logs", (c) => {
    if (!isDirectLoopbackRequest(c)) {
      return c.json({ error: "direct loopback access required" }, 403);
    }
    const parsed = QuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.date_from > parsed.data.date_to) {
      return c.json({ error: "date_from must be on or before date_to" }, 400);
    }
    const start = Date.parse(`${parsed.data.date_from}T00:00:00Z`);
    const end = Date.parse(`${parsed.data.date_to}T00:00:00Z`);
    if ((end - start) / 86_400_000 > 366) {
      return c.json({ error: "date range must not exceed 366 days" }, 400);
    }

    c.header("Cache-Control", "no-store");
    return c.json(buildMemoriaSpendingLog(deps.db, deps.rules, {
      dateFrom: parsed.data.date_from,
      dateTo: parsed.data.date_to,
    }));
  });

  return app;
}
