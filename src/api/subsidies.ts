import { Hono } from "hono";
import { z } from "zod";
import type { SubsidiesRepo, CreateSubsidyInput } from "../db/subsidies-repo.js";
import type { BusinessPlansRepo } from "../db/business-plans-repo.js";
import type { SubsidyMatcher } from "../services/subsidy-matcher.js";
import type { SubsidyCrawler } from "../services/subsidy-crawler.js";
import { buildPlanSummaryText } from "../services/business-plan-service.js";
import { suggestSubsidies } from "../services/subsidy-advisor.js";

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
const CrawlSchema = z.object({ keyword: z.string().min(2).max(100), limit: z.number().int().min(1).max(30).optional() });
const ImportSchema = z.object({
  candidates: z
    .array(CreateSchema.extend({
      external_id: z.string().optional(),
      metadata: z.record(z.unknown()).nullable().optional(),
    }))
    .min(1)
    .max(50),
});
const SuggestSchema = z.object({ plan_id: z.string().min(1), keywords: z.array(z.string().min(2).max(50)).max(6).optional() });

export interface SubsidiesApiDeps {
  repo: SubsidiesRepo;
  plans: BusinessPlansRepo;
  matcher?: SubsidyMatcher;
  crawler?: SubsidyCrawler;
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

  // POST /v1/subsidies/crawl — jGrants から keyword で募集中補助金を取得 (保存はしない、 プレビュー)
  app.post("/crawl", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CrawlSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!deps.crawler) return c.json({ candidates: [], disabled: true, reason: "クローラ未設定" });
    const found = await deps.crawler.search(parsed.data.keyword, { limit: parsed.data.limit });
    const candidates = found.map((c2) => ({ ...c2, already_saved: !!deps.repo.findByExternalId(c2.external_id) }));
    return c.json({ candidates });
  });

  // POST /v1/subsidies/import — クロール候補を subsidies に取り込み (jgrants_id で重複防止)
  app.post("/import", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ImportSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    let imported = 0;
    let skipped = 0;
    for (const cand of parsed.data.candidates) {
      const ext = cand.external_id;
      if (ext && deps.repo.findByExternalId(ext)) { skipped++; continue; }
      const { external_id: _omit, ...input } = cand;
      deps.repo.insert(input as CreateSubsidyInput);
      imported++;
    }
    return c.json({ imported, skipped });
  });

  // POST /v1/subsidies/suggest — 計画からキーワード導出 → クロール → マッチングして提案
  app.post("/suggest", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SuggestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!deps.plans.find(parsed.data.plan_id)) return c.json({ error: "plan not_found" }, 404);
    if (!deps.crawler || !deps.matcher) {
      return c.json({ suggestions: [], keywords: [], disabled: true, reason: "クローラ / matcher 未設定 (claude CLI 要)" });
    }
    const result = await suggestSubsidies(
      { plans: deps.plans, repo: deps.repo, crawler: deps.crawler, matcher: deps.matcher },
      parsed.data.plan_id,
      parsed.data.keywords,
    );
    return c.json(result);
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
