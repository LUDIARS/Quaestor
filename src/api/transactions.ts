import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { TransactionsRepo, ListFilter } from "../db/transactions-repo.js";
import { findAmazonLink } from "../services/amazon-link.js";

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
  db: Database.Database;
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

  // GET /v1/transactions/:id/amazon-link — クレカ Amazon 取引から Amazon Order History を逆引き
  app.get("/:id/amazon-link", (c) => {
    const t = deps.txs.find(c.req.param("id"));
    if (!t) return c.json({ error: "not_found" }, 404);
    const candidates = findAmazonLink(deps.db, t);
    return c.json({ transaction_id: t.id, candidates });
  });

  return app;
}
