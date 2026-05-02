import { Hono } from "hono";
import { z } from "zod";
import type { TransactionsRepo, ListFilter } from "../db/transactions-repo.js";

const ListQuerySchema = z.object({
  source: z.enum(["credit-card", "bank", "amazon", "receipt", "manual"]).optional(),
  account: z.string().optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payee_like: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export interface TransactionsApiDeps {
  txs: TransactionsRepo;
}

export function transactionsRouter(deps: TransactionsApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const filter: ListFilter = parsed.data;
    const items = deps.txs.list(filter);
    const total = deps.txs.count(filter);
    return c.json({ items, total, limit: filter.limit ?? 200, offset: filter.offset ?? 0 });
  });

  app.get("/:id", (c) => {
    const t = deps.txs.find(c.req.param("id"));
    if (!t) return c.json({ error: "not_found" }, 404);
    return c.json({ transaction: t });
  });

  return app;
}
