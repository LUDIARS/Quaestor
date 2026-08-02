/**
 * 請求書送信先台帳 CRUD。
 *
 * @implements SPEC-INVOICE-DELIVERY-001 (spec/feature/invoice-public-magic-link.md)
 */

import { Hono } from "hono";
import { z } from "zod";
import type { InvoiceDeliveryContactsRepo } from "../db/invoice-delivery-contacts-repo.js";

const ContactSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  active: z.boolean().optional(),
}).strict();

export function invoiceDeliveryContactsRouter(deps: { repo: InvoiceDeliveryContactsRepo }): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const includeInactive = c.req.query("include_inactive") === "true";
    return c.json({ items: deps.repo.list(includeInactive) });
  });

  app.get("/:id", (c) => {
    const contact = deps.repo.find(c.req.param("id"));
    return contact ? c.json({ contact }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/", async (c) => {
    const parsed = ContactSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.message }, 400);
    try {
      const contact = deps.repo.insert({
        companyName: parsed.data.company_name,
        email: parsed.data.email,
        active: parsed.data.active,
      });
      return c.json({ contact }, 201);
    } catch (error) {
      if (isUniqueConstraint(error)) return c.json({ error: "email_already_registered" }, 409);
      throw error;
    }
  });

  app.put("/:id", async (c) => {
    const parsed = ContactSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.message }, 400);
    try {
      const contact = deps.repo.update(c.req.param("id"), {
        companyName: parsed.data.company_name,
        email: parsed.data.email,
        active: parsed.data.active,
      });
      return contact ? c.json({ contact }) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      if (isUniqueConstraint(error)) return c.json({ error: "email_already_registered" }, 409);
      throw error;
    }
  });

  app.delete("/:id", (c) => {
    return deps.repo.deactivate(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "not_found" }, 404);
  });

  return app;
}

/**
 * better-sqlite3 の SqliteError は英語メッセージより `code` が安定しているので、
 * まず code で判定する。 メッセージ照合は古い driver 向けの保険に留める。
 */
function isUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    || /UNIQUE constraint failed/.test(error.message);
}
