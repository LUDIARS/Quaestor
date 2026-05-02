import { Hono } from "hono";
import { z } from "zod";
import type { AccountCodesRepo } from "../db/account-codes-repo.js";

const KindEnum = z.enum(["revenue", "expense", "asset", "liability"]);
const UpsertSchema = z.object({
  code: z.number().int().min(1).max(9999),
  name: z.string().min(1).max(100),
  kind: KindEnum,
});

export interface AccountCodesApiDeps {
  repo: AccountCodesRepo;
}

export function accountCodesRouter(deps: AccountCodesApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ items: deps.repo.list() }));

  app.get("/:code", (c) => {
    const code = parseInt(c.req.param("code"), 10);
    if (Number.isNaN(code)) return c.json({ error: "invalid code" }, 400);
    const r = deps.repo.find(code);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ account: r });
  });

  // PUT /v1/account-codes (upsert) — UI で追加・編集する用
  app.put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UpsertSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    deps.repo.upsert(parsed.data);
    return c.json({ ok: true, account: deps.repo.find(parsed.data.code) });
  });

  return app;
}
