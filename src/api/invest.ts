/**
 * 投資 / 優待アドバイザ API (`/v1/invest`)。
 *
 * GET 系は DB キャッシュのみ。 外部アクセス (Claude / stooq) を伴うのは
 * POST /map・/quotes/refresh・/perks/refresh の明示操作のみ。
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  InvestAdvisor,
  MapperUnavailable,
  StockUnavailable,
  PerkUnavailable,
} from "../services/invest-advisor.js";
import type { SecuritiesRepo } from "../db/securities-repo.js";
import type { PayeeSecuritiesRepo, SecurityRelation } from "../db/payee-securities-repo.js";

const BehaviorQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  min_visits: z.coerce.number().int().min(1).max(1000).optional(),
});

const MapBody = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  min_visits: z.coerce.number().int().min(1).max(1000).optional(),
});

const ManualMapBody = z.object({
  ticker: z.string().regex(/^\d{4}$/).nullable(),
  company_name: z.string().optional(),
  market: z.string().optional(),
  relation: z.enum(["operator", "brand", "parent", "none"]),
  payee_sample: z.string().optional(),
});

const RefreshBody = z.object({
  tickers: z.array(z.string().regex(/^\d{4}$/)).optional(),
  period_days: z.coerce.number().int().min(2).max(3650).optional(),
});

export function investRouter(deps: {
  advisor: InvestAdvisor;
  securities: SecuritiesRepo;
  payeeSecurities: PayeeSecuritiesRepo;
}): Hono {
  const app = new Hono();

  // GET /behavior — 行動解析ランキング
  app.get("/behavior", (c) => {
    const parsed = BehaviorQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { from, to, limit, min_visits } = parsed.data;
    return c.json({ items: deps.advisor.behavior({ from, to, limit, minVisits: min_visits }) });
  });

  // GET /securities — マッピング済の店名→銘柄リンク一覧
  app.get("/securities", (c) => {
    const links = deps.payeeSecurities.list();
    const items = links.map((l) => ({
      ...l,
      security: l.ticker ? (deps.securities.find(l.ticker) ?? null) : null,
    }));
    return c.json({ items });
  });

  // POST /map — 未マッピングの上位 payee を Claude で解析
  app.post("/map", async (c) => {
    const body = await safeJson(c);
    const parsed = MapBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { from, to, limit, min_visits } = parsed.data;
    try {
      const summary = await deps.advisor.mapTopPayees({ from, to, limit, minVisits: min_visits });
      return c.json({ summary });
    } catch (e) {
      if (e instanceof MapperUnavailable) return c.json({ error: e.message }, 503);
      throw e;
    }
  });

  // PUT /map/:payee_norm — 手動マッピング上書き
  app.put("/map/:payee_norm", async (c) => {
    const payeeNorm = decodeURIComponent(c.req.param("payee_norm"));
    const body = await safeJson(c);
    const parsed = ManualMapBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const d = parsed.data;
    const relation: SecurityRelation = d.ticker ? d.relation : "none";
    if (d.ticker) {
      deps.securities.upsert({
        ticker: d.ticker,
        name: d.company_name ?? d.ticker,
        market: d.market ?? null,
      });
    }
    deps.payeeSecurities.upsert({
      payee_norm: payeeNorm,
      payee_sample: d.payee_sample ?? null,
      ticker: d.ticker,
      relation,
      confidence: 1,
      reason: "手動指定",
      source: "manual",
    });
    return c.json({ ok: true, mapping: deps.payeeSecurities.find(payeeNorm) });
  });

  // POST /quotes/refresh — 株価取得
  app.post("/quotes/refresh", async (c) => {
    const body = await safeJson(c);
    const parsed = RefreshBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const summary = await deps.advisor.refreshQuotes({
        tickers: parsed.data.tickers,
        periodDays: parsed.data.period_days,
      });
      return c.json({ summary });
    } catch (e) {
      if (e instanceof StockUnavailable) return c.json({ error: e.message }, 503);
      throw e;
    }
  });

  // POST /perks/refresh — 優待取得
  app.post("/perks/refresh", async (c) => {
    const body = await safeJson(c);
    const parsed = RefreshBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const summary = await deps.advisor.refreshPerks({ tickers: parsed.data.tickers });
      return c.json({ summary });
    } catch (e) {
      if (e instanceof PerkUnavailable) return c.json({ error: e.message }, 503);
      throw e;
    }
  });

  // GET /suggestions — 統合提案
  app.get("/suggestions", (c) => {
    const parsed = BehaviorQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { from, to, limit, min_visits } = parsed.data;
    return c.json({ items: deps.advisor.suggestions({ from, to, limit, minVisits: min_visits }) });
  });

  return app;
}

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
