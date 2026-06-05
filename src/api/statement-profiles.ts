/**
 * 明細プロファイル CRUD API (`/v1/statement-profiles`)。
 * クレカ等の CSV 列マッピングを外部登録するためのエンドポイント。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { StatementProfilesRepo, UpsertProfileInput } from "../db/statement-profiles-repo.js";

const ProfileSchema = z.object({
  name: z.string().min(1),
  brand: z.string().min(1).regex(/^[a-z0-9_-]+$/, "brand は英小文字/数字/-/_ のみ"),
  source: z.enum(["credit-card", "bank", "amazon", "receipt", "manual"]).optional(),
  encoding: z.enum(["auto", "shift_jis", "utf-8"]).optional(),
  header_skip: z.number().int().min(0).max(100).optional(),
  col_date: z.number().int().min(0).max(200),
  col_payee: z.number().int().min(0).max(200),
  col_amount: z.number().int().min(0).max(200),
  col_memo: z.number().int().min(0).max(200).nullable().optional(),
  amount_sign: z.enum(["out", "in", "signed"]).optional(),
  filter_col: z.number().int().min(0).max(200).nullable().optional(),
  filter_value: z.string().nullable().optional(),
  date_year_hint: z.number().int().min(1900).max(2100).nullable().optional(),
  account_default: z.string().nullable().optional(),
  detect_keywords: z.array(z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
});

export function statementProfilesRouter(deps: { repo: StatementProfilesRepo }): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ items: deps.repo.list() }));

  app.get("/:id", (c) => {
    const row = deps.repo.find(Number(c.req.param("id")));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ profile: row });
  });

  app.post("/", async (c) => {
    const parsed = ProfileSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const id = deps.repo.insert(parsed.data as UpsertProfileInput);
      return c.json({ profile: deps.repo.find(id) }, 201);
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
        return c.json({ error: `brand "${parsed.data.brand}" は既に登録済` }, 409);
      }
      throw e;
    }
  });

  app.put("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!deps.repo.find(id)) return c.json({ error: "not found" }, 404);
    const parsed = ProfileSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      deps.repo.update(id, parsed.data as UpsertProfileInput);
      return c.json({ profile: deps.repo.find(id) });
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
        return c.json({ error: `brand "${parsed.data.brand}" は既に登録済` }, 409);
      }
      throw e;
    }
  });

  app.delete("/:id", (c) => {
    const ok = deps.repo.delete(Number(c.req.param("id")));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  return app;
}
