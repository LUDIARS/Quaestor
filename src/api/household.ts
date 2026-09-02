/**
 * 家計 API (/v1/household)。 分析 / 家計費目 CRUD / 家計費目ルール CRUD。
 *
 * @implements SPEC-HOUSEHOLD-ANALYSIS-002 (spec/feature/household-bookkeeping.md)
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-002 (spec/feature/household-bookkeeping.md)
 */

import { Hono } from "hono";
import { z } from "zod";
import type { HouseholdCategoriesRepo } from "../db/household-categories-repo.js";
import type { HouseholdRulesRepo } from "../db/household-rules-repo.js";
import type { HouseholdClassifier } from "../services/household/household-classifier.js";
import { ANALYSIS_WINDOWS } from "../services/household/analysis-windows.js";
import { analyzeHousehold, type HouseholdAnalysisDeps } from "../services/household/household-analysis.js";
import { isIsoDate } from "../shared/text.js";

const AnalysisQuery = z.object({
  window: z.enum(ANALYSIS_WINDOWS as [string, ...string[]]).default("month"),
  anchor: z.string().refine(isIsoDate, "invalid calendar date").optional(),
  top_places: z.coerce.number().int().min(1).max(200).optional(),
  top_locations: z.coerce.number().int().min(1).max(200).optional(),
});

const CategoryCreate = z.object({
  name: z.string().trim().min(1).max(100),
  parent_id: z.number().int().positive().nullable().optional(),
  display_order: z.number().int().optional(),
});
const CategoryUpdate = CategoryCreate.partial();

const RuleCreate = z.object({
  pattern: z.string().min(1).max(500),
  category_id: z.number().int().positive(),
  priority: z.number().int().min(0).max(99999).optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});
const RuleUpdate = RuleCreate.partial();

const ClassifyBody = z.object({ payee: z.string().min(1).max(500) });

export interface HouseholdApiDeps {
  analysis: HouseholdAnalysisDeps;
  categories: HouseholdCategoriesRepo;
  rules: HouseholdRulesRepo;
  classifier: HouseholdClassifier;
  /** テストで固定するための「今日」 */
  today?: () => string;
}

function validRegex(pattern: string): string | null {
  try { new RegExp(pattern, "i"); }
  catch (e: unknown) { return `invalid regex: ${(e as Error).message}`; }
  // Payees are request/data controlled. Disallow constructs that can trigger
  // catastrophic backtracking in JavaScript's backtracking regex engine.
  if (/\\[1-9]/.test(pattern) || hasQuantifiedGroup(pattern)) return "unsafe regex construct";
  return null;
}

function hasQuantifiedGroup(pattern: string): boolean {
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch !== ")") continue;
    const next = pattern.slice(i + 1).trimStart()[0];
    if (next === "*" || next === "+" || next === "?" || next === "{") return true;
  }
  return false;
}

function validParent(categories: HouseholdCategoriesRepo, parentId: number | null | undefined, categoryId?: number): boolean {
  if (parentId === null || parentId === undefined) return true;
  if (parentId === categoryId) return false;
  const parent = categories.find(parentId);
  return parent !== undefined && parent.parent_id === null;
}

export function householdRouter(deps: HouseholdApiDeps): Hono {
  const app = new Hono();
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));

  app.get("/analysis", (c) => {
    const parsed = AnalysisQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const q = parsed.data;
    const window = q.window as (typeof ANALYSIS_WINDOWS)[number];
    const result = analyzeHousehold(deps.analysis, window, q.anchor ?? today(), {
      top_places: q.top_places, top_locations: q.top_locations,
    });
    return c.json(result);
  });

  app.get("/windows", (c) => c.json({ windows: ANALYSIS_WINDOWS }));

  // ---- categories ----
  app.get("/categories", (c) => c.json({ items: deps.categories.list() }));

  app.post("/categories", async (c) => {
    const parsed = CategoryCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (deps.categories.findByName(parsed.data.name)) return c.json({ error: "duplicate name" }, 409);
    if (!validParent(deps.categories, parsed.data.parent_id)) return c.json({ error: "invalid parent category" }, 400);
    const id = deps.categories.insert(parsed.data);
    deps.classifier.invalidate();
    return c.json({ category: deps.categories.find(id) }, 201);
  });

  app.patch("/categories/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const parsed = CategoryUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!deps.categories.find(id)) return c.json({ error: "not_found" }, 404);
    if (parsed.data.name) {
      const duplicate = deps.categories.findByName(parsed.data.name);
      if (duplicate && duplicate.id !== id) return c.json({ error: "duplicate name" }, 409);
    }
    if (!validParent(deps.categories, parsed.data.parent_id, id)) return c.json({ error: "invalid parent category" }, 400);
    const ok = deps.categories.update(id, parsed.data);
    if (!ok) return c.json({ error: "not_found" }, 404);
    deps.classifier.invalidate();
    return c.json({ category: deps.categories.find(id) });
  });

  app.delete("/categories/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const ok = deps.categories.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    deps.classifier.invalidate();
    return c.json({ ok: true });
  });

  // ---- rules ----
  app.get("/rules", (c) => {
    const includeDisabled = c.req.query("include_disabled") === "1";
    return c.json({ items: deps.rules.list(includeDisabled) });
  });

  app.post("/rules", async (c) => {
    const parsed = RuleCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const bad = validRegex(parsed.data.pattern);
    if (bad) return c.json({ error: bad }, 400);
    if (!deps.categories.find(parsed.data.category_id)) return c.json({ error: "unknown category" }, 400);
    const id = deps.rules.insert(parsed.data);
    return c.json({ rule: deps.rules.find(id) }, 201);
  });

  app.patch("/rules/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const parsed = RuleUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.pattern) {
      const bad = validRegex(parsed.data.pattern);
      if (bad) return c.json({ error: bad }, 400);
    }
    if (parsed.data.category_id !== undefined && !deps.categories.find(parsed.data.category_id)) {
      return c.json({ error: "unknown category" }, 400);
    }
    const ok = deps.rules.update(id, parsed.data);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ rule: deps.rules.find(id) });
  });

  app.delete("/rules/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const ok = deps.rules.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/classify", async (c) => {
    const parsed = ClassifyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(deps.classifier.classify(parsed.data.payee));
  });

  return app;
}
