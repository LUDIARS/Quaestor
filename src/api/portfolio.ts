/**
 * 積立ポートフォリオ / 配当アドバイザ API (`/v1/portfolio`)。
 *
 * GET 系は DB キャッシュのみ。 外部アクセス (stooq / Claude) を伴うのは
 * POST /valuations/refresh・/dividends/suggest の明示操作のみ。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { HoldingsRepo } from "../db/holdings-repo.js";
import type { ContributionsRepo } from "../db/contributions-repo.js";
import type { HoldingValuationsRepo } from "../db/holding-valuations-repo.js";
import type { HoldingDividendsRepo } from "../db/holding-dividends-repo.js";
import {
  PortfolioService,
  HoldingNotFound,
  StockUnavailable,
  DividendUnavailable,
} from "../services/portfolio-service.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const KIND = z.enum(["fund", "stock", "etf", "insurance", "other"]);
const STATUS = z.enum(["active", "paused", "closed"]);
const TAX_WRAPPER = z.enum(["nisa_tsumitate", "nisa_growth", "ideco", "taxable", "insurance"]);
const TICKER = z.string().regex(/^\d{4}$/);

const HoldingBody = z.object({
  kind: KIND,
  name: z.string().min(1),
  account: z.string().nullish(),
  ticker: TICKER.nullish(),
  fund_code: z.string().nullish(),
  currency: z.string().optional(),
  tax_wrapper: TAX_WRAPPER.nullish(),
  target_amount: z.number().int().nullish(),
  monthly_contribution: z.number().int().nullish(),
  status: STATUS.optional(),
  started_at: DATE.nullish(),
  notes: z.string().nullish(),
});

const HoldingPatch = HoldingBody.partial();

const ContributionBody = z.object({
  date: DATE,
  amount: z.number().int(),
  kind: z.enum(["planned", "actual"]).optional(),
  units: z.number().nullish(),
  unit_price: z.number().nullish(),
  note: z.string().nullish(),
});

const ValuationBody = z.object({
  as_of: DATE,
  market_value: z.number().int(),
  unit_price: z.number().nullish(),
  units: z.number().nullish(),
  fx_rate: z.number().nullish(),
  note: z.string().nullish(),
});

const DividendBody = z.object({
  pay_date: DATE,
  amount: z.number().int(),
  per_share: z.number().nullish(),
  reinvested: z.boolean().optional(),
  note: z.string().nullish(),
});

const RefreshBody = z.object({
  holding_ids: z.array(z.string()).optional(),
});

const SuggestBody = z.object({
  tickers: z.array(TICKER).optional(),
});

export function portfolioRouter(deps: {
  service: PortfolioService;
  holdings: HoldingsRepo;
  contributions: ContributionsRepo;
  valuations: HoldingValuationsRepo;
  dividends: HoldingDividendsRepo;
}): Hono {
  const app = new Hono();

  // GET /summary — 全 holding の利回り + ポートフォリオ合計
  app.get("/summary", (c) => {
    const asOf = c.req.query("as_of") ?? today();
    const statusRaw = c.req.query("status");
    const status = STATUS.safeParse(statusRaw);
    return c.json(deps.service.summary(asOf, status.success ? { status: status.data } : {}));
  });

  // GET /holdings — 編集用の生 holding 一覧
  app.get("/holdings", (c) => c.json({ items: deps.holdings.list() }));

  // POST /holdings — 作成
  app.post("/holdings", async (c) => {
    const parsed = HoldingBody.safeParse(await safeJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ holding: deps.holdings.create(parsed.data) }, 201);
  });

  // GET /holdings/:id — 明細 (拠出/時価/配当/利回り)
  app.get("/holdings/:id", (c) => {
    const id = c.req.param("id");
    const holding = deps.holdings.find(id);
    if (!holding) return c.json({ error: "not found" }, 404);
    const asOf = c.req.query("as_of") ?? today();
    return c.json({
      holding,
      contributions: deps.contributions.list(id),
      valuations: deps.valuations.list(id),
      dividends: deps.dividends.list(id),
      ret: deps.service.holdingSummary(holding, asOf).ret,
    });
  });

  // PUT /holdings/:id — 部分更新
  app.put("/holdings/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.holdings.find(id)) return c.json({ error: "not found" }, 404);
    const parsed = HoldingPatch.safeParse(await safeJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ holding: deps.holdings.update(id, parsed.data) });
  });

  // DELETE /holdings/:id
  app.delete("/holdings/:id", (c) => {
    const ok = deps.holdings.remove(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // POST /holdings/:id/contributions — 拠出 (計画/実績) 追加
  app.post("/holdings/:id/contributions", async (c) => {
    const id = c.req.param("id");
    if (!deps.holdings.find(id)) return c.json({ error: "not found" }, 404);
    const parsed = ContributionBody.safeParse(await safeJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ contribution: deps.contributions.add({ holding_id: id, ...parsed.data }) }, 201);
  });

  // DELETE /contributions/:cid
  app.delete("/contributions/:cid", (c) => {
    const cid = Number(c.req.param("cid"));
    const ok = Number.isFinite(cid) && deps.contributions.remove(cid);
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // POST /holdings/:id/valuations — 時価スナップショット (手動)
  app.post("/holdings/:id/valuations", async (c) => {
    const id = c.req.param("id");
    if (!deps.holdings.find(id)) return c.json({ error: "not found" }, 404);
    const parsed = ValuationBody.safeParse(await safeJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(
      { valuation: deps.valuations.upsert({ holding_id: id, source: "manual", ...parsed.data }) },
      201,
    );
  });

  // POST /holdings/:id/dividends — 受取配当/分配金 追加
  app.post("/holdings/:id/dividends", async (c) => {
    const id = c.req.param("id");
    if (!deps.holdings.find(id)) return c.json({ error: "not found" }, 404);
    const parsed = DividendBody.safeParse(await safeJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ dividend: deps.dividends.add({ holding_id: id, ...parsed.data }) }, 201);
  });

  // DELETE /dividends/:did
  app.delete("/dividends/:did", (c) => {
    const did = Number(c.req.param("did"));
    const ok = Number.isFinite(did) && deps.dividends.remove(did);
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // GET /projection — 将来見通し (holding_id 指定で個別、 無指定でポートフォリオ全体)
  app.get("/projection", (c) => {
    const holdingId = c.req.query("holding_id") ?? null;
    const years = Number(c.req.query("years") ?? 20);
    const asOf = c.req.query("as_of") ?? today();
    try {
      return c.json(deps.service.projection(holdingId, { years, asOf }));
    } catch (e) {
      if (e instanceof HoldingNotFound) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // POST /valuations/refresh — 個別株/ETF の時価を stooq 更新
  app.post("/valuations/refresh", async (c) => {
    const parsed = RefreshBody.safeParse(await safeJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const summary = await deps.service.refreshValuations({
        holdingIds: parsed.data.holding_ids,
        asOf: today(),
      });
      return c.json({ summary });
    } catch (e) {
      if (e instanceof StockUnavailable) return c.json({ error: e.message }, 503);
      throw e;
    }
  });

  // GET /dividends/candidates — 配当株サジェスト一覧 (公開情報ベース)
  app.get("/dividends/candidates", (c) => c.json({ items: deps.service.dividendCandidates() }));

  // POST /dividends/suggest — Claude で配当の公開データを取得・キャッシュ
  app.post("/dividends/suggest", async (c) => {
    const parsed = SuggestBody.safeParse(await safeJson(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const summary = await deps.service.suggestDividends({ tickers: parsed.data.tickers });
      return c.json({ summary });
    } catch (e) {
      if (e instanceof DividendUnavailable) return c.json({ error: e.message }, 503);
      throw e;
    }
  });

  return app;
}

/** ローカル時刻ベースの yyyy-mm-dd (JST 環境で UTC ズレを避ける)。 */
function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
