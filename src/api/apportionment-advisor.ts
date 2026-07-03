import { Hono } from "hono";
import { z } from "zod";
import type { ApportionmentAdvisor } from "../services/apportionment-advisor.js";

const AdviseSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

const VerdictSchema = z.object({
  verdict: z.enum(["ok", "ng"]),
});

export interface ApportionmentAdvisorApiDeps {
  advisor: ApportionmentAdvisor;
}

/**
 * /v1/apportionment-advisor — 未知 payee の科目学習 (成長型ブラックボックス)。
 *
 *   POST /advise           未知 payee を判定 (学習済みルールは即決 / 未知は LLM)
 *   GET  /unknown          未マッチ payee 一覧 (支出額順)
 *   GET  /review           レビュー待ち判断キュー
 *   POST /review/:id       OK/NG (卒業で apportionment_rules へ実体化)
 *   GET  /rules            blackbox ルール一覧 + 卒業メトリクス
 */
export function apportionmentAdvisorRouter(deps: ApportionmentAdvisorApiDeps): Hono {
  const app = new Hono();

  app.post("/advise", async (c) => {
    if (!deps.advisor.llmAvailable) {
      return c.json({ error: "claude CLI unavailable (QUAESTOR_CLAUDE_CLI_DISABLE?)" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AdviseSchema.safeParse(body ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const items = await deps.advisor.adviseUnknown(parsed.data.limit ?? 10);
    return c.json({ items });
  });

  app.get("/unknown", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    return c.json({ items: deps.advisor.listUnknownPayees(limit) });
  });

  app.get("/review", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    return c.json({ items: deps.advisor.pending(limit) });
  });

  app.post("/review/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = VerdictSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const res = deps.advisor.review(id, parsed.data.verdict);
    if (!res.ok) return c.json({ error: "not_found" }, 404);
    return c.json(res);
  });

  app.get("/rules", (c) => {
    return c.json({ rules: deps.advisor.listRules(), stats: deps.advisor.stats() });
  });

  return app;
}
