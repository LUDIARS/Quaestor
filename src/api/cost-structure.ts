/**
 * 固定費 / 変動費ビュー・水道光熱費スキャン・固定費候補・分類ルール CRUD (/v1/cost-structure)。
 * @implements SPEC-COST-STRUCTURE-004 (spec/feature/cost-structure.md)
 */

import { Hono } from "hono";
import { z } from "zod";
import type { CostRulesRepo } from "../db/cost-rules-repo.js";
import type { CostStructureService } from "../services/cost-structure/cost-structure.js";
import { ANALYSIS_WINDOWS } from "../services/household/analysis-windows.js";
import { escapeRegex } from "../services/apportionment-sheet/rule-synthesizer.js";
import { isIsoDate } from "../shared/text.js";

const IsoDate = z.string().refine(isIsoDate, "invalid date");
const ViewQuery = z.object({ window: z.enum(ANALYSIS_WINDOWS as [string, ...string[]]).default("month"), anchor: IsoDate.optional() });
const UtilQuery = z.object({ months: z.coerce.number().int().min(1).max(36).optional(), anchor: IsoDate.optional() });
const SuggestQuery = z.object({ months: z.coerce.number().int().min(2).max(24).optional(), anchor: IsoDate.optional() });
const ApplyBody = z.object({ payees: z.array(z.string().min(1).max(200)).min(1).max(500), cost_type: z.enum(["fixed", "variable"]).default("fixed") });
const RuleCreate = z.object({
  pattern: z.string().min(1).max(500),
  cost_type: z.enum(["fixed", "variable"]),
  utility: z.enum(["electric", "gas", "water"]).nullable().optional(),
  label: z.string().max(100).nullable().optional(),
  priority: z.number().int().min(0).max(99999).optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});
const RuleUpdate = RuleCreate.partial();

export const SUGGESTION_RULE_PRIORITY = 300;

export interface CostStructureApiDeps {
  rules: CostRulesRepo;
  service: CostStructureService;
  today?: () => string;
}

function validRegex(pattern: string): string | null {
  try { new RegExp(pattern, "i"); }
  catch (e: unknown) { return `invalid regex: ${(e as Error).message}`; }
  // JavaScript の RegExp には実行時間制限が無い。ユーザ入力で特に危険な
  // backreference と group repetition は、支払先を照合する同期 API を止め得るため受け付けない。
  if (/\\(?:[1-9]|k<)/.test(pattern) || /\)(?:[+*?]|\{\d)/.test(pattern)) {
    return "unsafe regex: backreferences and repeated groups are not supported";
  }
  return null;
}

function idOf(param: string): number | null {
  if (!/^[1-9]\d*$/.test(param)) return null;
  const id = Number(param);
  return Number.isSafeInteger(id) ? id : null;
}

export function costStructureRouter(deps: CostStructureApiDeps): Hono {
  const app = new Hono();
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));

  app.get("/", (c) => {
    const parsed = ViewQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(deps.service.view(parsed.data.window as (typeof ANALYSIS_WINDOWS)[number], parsed.data.anchor ?? today()));
  });

  app.get("/utilities", (c) => {
    const parsed = UtilQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(deps.service.utilities(parsed.data.anchor ?? today(), parsed.data.months ?? 12));
  });

  app.get("/suggestions", (c) => {
    const parsed = SuggestQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ items: deps.service.suggestions(parsed.data.anchor ?? today(), parsed.data.months ?? 6) });
  });

  app.post("/suggestions/apply", async (c) => {
    const parsed = ApplyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const created: number[] = [];
    const reactivated: number[] = [];
    const skipped: string[] = [];
    for (const payee of parsed.data.payees) {
      const pattern = `^${escapeRegex(payee)}$`;
      const existing = deps.rules.findByPattern(pattern);
      if (existing?.enabled) { skipped.push(payee); continue; }
      if (existing) {
        deps.rules.update(existing.id, {
          cost_type: parsed.data.cost_type,
          label: payee,
          priority: SUGGESTION_RULE_PRIORITY,
          enabled: true,
          note: `suggest:${today()}`,
        });
        reactivated.push(existing.id);
        continue;
      }
      created.push(deps.rules.insert({ pattern, cost_type: parsed.data.cost_type, label: payee, priority: SUGGESTION_RULE_PRIORITY, note: `suggest:${today()}` }));
    }
    return c.json({ created: created.length, reactivated: reactivated.length, rule_ids: [...created, ...reactivated], skipped });
  });

  app.get("/rules", (c) => c.json({ items: deps.rules.list(c.req.query("include_disabled") === "1") }));

  app.post("/rules", async (c) => {
    const parsed = RuleCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const bad = validRegex(parsed.data.pattern);
    if (bad) return c.json({ error: bad }, 400);
    const id = deps.rules.insert(parsed.data);
    return c.json({ rule: deps.rules.find(id) }, 201);
  });

  app.patch("/rules/:id", async (c) => {
    const id = idOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const parsed = RuleUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.pattern) { const bad = validRegex(parsed.data.pattern); if (bad) return c.json({ error: bad }, 400); }
    if (!deps.rules.update(id, parsed.data)) return c.json({ error: "not_found" }, 404);
    return c.json({ rule: deps.rules.find(id) });
  });

  app.delete("/rules/:id", (c) => {
    const id = idOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    if (!deps.rules.delete(id)) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
