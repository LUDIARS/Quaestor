import { Hono } from "hono";
import { z } from "zod";
import type { ApportionmentRulesRepo } from "../db/apportionment-rules-repo.js";

const CreateSchema = z.object({
  pattern: z.string().min(1).max(500),
  rate: z.number().min(0).max(1),
  code: z.number().int().min(1).max(9999),
  priority: z.number().int().min(0).max(99999).optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

const UpdateSchema = CreateSchema.partial();

const ResolveSchema = z.object({
  payee: z.string().min(1).max(500),
});

export interface ApportionmentRulesApiDeps {
  repo: ApportionmentRulesRepo;
}

export function apportionmentRulesRouter(deps: ApportionmentRulesApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const includeDisabled = c.req.query("include_disabled") === "1";
    return c.json({ items: deps.repo.list(includeDisabled) });
  });

  app.get("/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const r = deps.repo.find(id);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ rule: r });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    // pattern が valid な regex か即時バリデート
    try { new RegExp(parsed.data.pattern, "i"); }
    catch (e: unknown) { return c.json({ error: `invalid regex: ${(e as Error).message}` }, 400); }
    const id = deps.repo.insert(parsed.data);
    return c.json({ rule: deps.repo.find(id) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.pattern) {
      try { new RegExp(parsed.data.pattern, "i"); }
      catch (e: unknown) { return c.json({ error: `invalid regex: ${(e as Error).message}` }, 400); }
    }
    const ok = deps.repo.update(id, parsed.data);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ rule: deps.repo.find(id) });
  });

  app.delete("/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const ok = deps.repo.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // POST /v1/apportionment-rules/resolve { payee } → { rate, code, rule_id }
  app.post("/resolve", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ResolveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const result = deps.repo.resolve(parsed.data.payee);
    return c.json(result);
  });

  return app;
}
