import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { BusinessPlansRepo } from "../db/business-plans-repo.js";
import type { FinancialStatementsRepo } from "../db/financial-statements-repo.js";
import type { PlanReviewer } from "../services/plan-reviewer.js";
import { TEMPLATES } from "../business-plan/templates.js";
import { runReview, seedFromActuals, computePlanVariance } from "../services/business-plan-service.js";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const PurposeEnum = z.enum(["funding", "subsidy", "internal"]);
const StatusEnum = z.enum(["draft", "review", "final"]);
const FiscalStart = z.string().regex(/^\d{4}-\d{2}$/);

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  template: z.string().min(1).max(50),
  purpose: PurposeEnum.optional(),
  fiscal_start: FiscalStart.nullable().optional(),
  horizon_years: z.number().int().min(1).max(10).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  purpose: PurposeEnum.optional(),
  status: StatusEnum.optional(),
  fiscal_start: FiscalStart.nullable().optional(),
  horizon_years: z.number().int().min(1).max(10).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const SectionSchema = z.object({ body: z.string().max(20000) });

const FiguresSchema = z.object({
  figures: z
    .array(
      z.object({
        category: z.string().min(1).max(40),
        label: z.string().min(1).max(120),
        period: z.string().min(1).max(10),
        amount: z.number().int().nullable(),
        display_order: z.number().int().optional(),
        metadata: z.record(z.unknown()).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

const ReviewQuery = z.object({ kind: z.enum(["quantitative", "qualitative", "combined"]).optional() });

export interface BusinessPlansApiDeps {
  repo: BusinessPlansRepo;
  fs: FinancialStatementsRepo;
  db: Database.Database;
  reviewer?: PlanReviewer;
}

export function businessPlansRouter(deps: BusinessPlansApiDeps): Hono {
  const app = new Hono();

  app.get("/templates", (c) =>
    c.json({
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        purpose: t.purpose,
        horizon_years: t.horizonYears,
        description: t.description,
        sections: t.sections,
        figures: t.figures,
      })),
    }),
  );

  app.get("/", (c) => c.json({ items: deps.repo.list() }));

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!TEMPLATES.some((t) => t.id === parsed.data.template)) {
      return c.json({ error: "unknown template" }, 400);
    }
    const id = deps.repo.create(parsed.data);
    return c.json({ plan: full(deps.repo, id) }, 201);
  });

  app.get("/:id", (c) => {
    const plan = full(deps.repo, c.req.param("id"));
    if (!plan) return c.json({ error: "not_found" }, 404);
    return c.json({ plan });
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    deps.repo.updateMeta(id, parsed.data);
    return c.json({ plan: full(deps.repo, id) });
  });

  app.delete("/:id", (c) => {
    const ok = deps.repo.delete(c.req.param("id"));
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.put("/:id/sections/:key", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = SectionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    deps.repo.upsertSection(id, c.req.param("key"), parsed.data.body);
    return c.json({ plan: full(deps.repo, id) });
  });

  app.put("/:id/figures", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = FiguresSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const count = deps.repo.upsertFigures(id, parsed.data.figures);
    return c.json({ updated: count, plan: full(deps.repo, id) });
  });

  app.get("/:id/variance", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    return c.json(computePlanVariance(deps.repo, deps.db, id, today()));
  });

  app.post("/:id/seed-from-actuals", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const result = seedFromActuals(deps.repo, deps.fs, id);
    return c.json({ ...result, plan: full(deps.repo, id) });
  });

  app.post("/:id/review", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const parsed = ReviewQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const kind = parsed.data.kind ?? "combined";
    if ((kind === "qualitative" || kind === "combined") && !deps.reviewer) {
      // 定性レビュー不可 (API key 無し)。 quantitative に縮退して通知する
      const result = await runReview(deps.repo, id, "quantitative", undefined);
      return c.json({ result, downgraded: true, reason: "qualitative review disabled (no ANTHROPIC_API_KEY)" });
    }
    const result = await runReview(deps.repo, id, kind, deps.reviewer);
    return c.json({ result, downgraded: false });
  });

  app.get("/:id/reviews", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    return c.json({ reviews: deps.repo.reviews(id) });
  });

  return app;
}

/** plan 詳細 (meta + sections + figures + 最新 review) を組み立てる */
function full(repo: BusinessPlansRepo, id: string) {
  const plan = repo.find(id);
  if (!plan) return null;
  return {
    ...plan,
    sections: repo.sections(id),
    figures: repo.figures(id),
    latest_review: repo.latestReview(id) ?? null,
  };
}
