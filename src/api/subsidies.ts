import { Hono } from "hono";
import { z } from "zod";
import type { SubsidiesRepo } from "../db/subsidies-repo.js";
import type { BusinessPlansRepo } from "../db/business-plans-repo.js";
import type { SubsidyMatcher } from "../services/subsidy-matcher.js";
import { buildPlanSummaryText } from "../services/business-plan-service.js";

const KindEnum = z.enum(["subsidy", "grant", "loan", "other"]);
const StatusEnum = z.enum(["open", "upcoming", "closed"]);
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  agency: z.string().max(200).nullable().optional(),
  kind: KindEnum.optional(),
  url: z.string().max(1000).nullable().optional(),
  summary: z.string().max(4000).nullable().optional(),
  target: z.string().max(2000).nullable().optional(),
  requirements: z.string().max(8000).nullable().optional(),
  max_amount: z.number().int().nullable().optional(),
  subsidy_rate: z.number().min(0).max(1).nullable().optional(),
  deadline: Iso.nullable().optional(),
  status: StatusEnum.optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateSchema = CreateSchema.partial();
const ListSchema = z.object({ status: StatusEnum.optional() });
const MatchSchema = z.object({ plan_id: z.string().min(1) });

export interface SubsidiesApiDeps {
  repo: SubsidiesRepo;
  plans: BusinessPlansRepo;
  matcher?: SubsidyMatcher;
}

export function subsidiesRouter(deps: SubsidiesApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const parsed = ListSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ items: deps.repo.list(parsed.data) });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const id = deps.repo.insert(parsed.data);
    return c.json({ subsidy: deps.repo.find(id) }, 201);
  });

  app.get("/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const r = deps.repo.find(id);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ subsidy: r });
  });

  app.patch("/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ok = deps.repo.update(id, parsed.data);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ subsidy: deps.repo.find(id) });
  });

  app.delete("/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const ok = deps.repo.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // POST /v1/subsidies/match — 事業計画に合う補助金を Claude でランク付け
  app.post("/match", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = MatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!deps.plans.find(parsed.data.plan_id)) return c.json({ error: "plan not_found" }, 404);
    if (!deps.matcher) {
      return c.json({ matches: [], disabled: true, reason: "claude CLI / API key 無しのためマッチング不可" });
    }
    const open = deps.repo.list({ status: "open" });
    if (open.length === 0) return c.json({ matches: [], reason: "募集中 (open) の補助金がありません" });
    const planSummary = buildPlanSummaryText(deps.plans, parsed.data.plan_id);
    const matches = await deps.matcher.match({
      planSummary,
      subsidies: open.map((s) => ({ id: s.id, name: s.name, target: s.target, requirements: s.requirements })),
    });
    // subsidy の表示情報を join して返す
    const byId = new Map(open.map((s) => [s.id, s]));
    return c.json({
      matches: matches.map((m) => ({ ...m, subsidy: byId.get(m.subsidy_id) ?? null })),
    });
  });

  return app;
}
