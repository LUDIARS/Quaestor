/**
 * 請求書 CRUD API。
 *
 * @implements SPEC-INVOICE-DELIVERY-003 (spec/feature/invoice-public-magic-link.md)
 */

import { Hono } from "hono";
import { z } from "zod";
import type { InvoicesRepo } from "../db/invoices-repo.js";
import { invoiceIdOf } from "./invoice-id.js";

const StatusEnum = z.enum(["draft", "sent", "paid", "overdue", "cancelled"]);
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateSchema = z.object({
  issued_at: Iso,
  due_date: Iso.nullable().optional(),
  client: z.string().min(1).max(200),
  work_summary: z.string().min(1).max(2000),
  amount: z.number().int(),
  withholding_tax: z.number().int().min(0).optional(),
  status: StatusEnum.optional(),
  transaction_id: z.string().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
const UpdateSchema = CreateSchema.partial();
const ListSchema = z.object({
  status: StatusEnum.optional(),
  client: z.string().optional(),
  date_from: Iso.optional(),
  date_to: Iso.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function invoicesRouter(deps: { repo: InvoicesRepo }): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const parsed = ListSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ items: deps.repo.list(parsed.data) });
  });

  app.get("/summary", (c) => c.json({ summary: deps.repo.summary() }));

  app.get("/:id", (c) => {
    const id = invoiceIdOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const r = deps.repo.find(id);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ invoice: r });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const id = deps.repo.insert(parsed.data);
    return c.json({ invoice: deps.repo.find(id) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = invoiceIdOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ok = deps.repo.update(id, parsed.data);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ invoice: deps.repo.find(id) });
  });

  app.delete("/:id", (c) => {
    const id = invoiceIdOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const ok = deps.repo.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
