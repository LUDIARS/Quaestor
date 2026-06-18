import { Hono } from "hono";
import { z } from "zod";
import type { NotificationService } from "../services/notification-service.js";
import type { BusinessPlansRepo } from "../db/business-plans-repo.js";

const DedupSchema = z.object({ dedup: z.boolean().optional() });
const SubsidyNotifySchema = z.object({ plan_id: z.string().min(1), dedup: z.boolean().optional() });

export interface NotificationsApiDeps {
  service: NotificationService;
  plans: BusinessPlansRepo;
}

export function notificationsRouter(deps: NotificationsApiDeps): Hono {
  const app = new Hono();

  app.post("/invest", async (c) => {
    const parsed = DedupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(await deps.service.notifyInvest(parsed.data));
  });

  app.post("/portfolio", async (c) => {
    const parsed = DedupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(await deps.service.notifyDividends(parsed.data));
  });

  app.post("/subsidies", async (c) => {
    const parsed = SubsidyNotifySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!deps.plans.find(parsed.data.plan_id)) return c.json({ error: "plan not_found" }, 404);
    return c.json(await deps.service.notifySubsidies(parsed.data.plan_id, { dedup: parsed.data.dedup }));
  });

  return app;
}
