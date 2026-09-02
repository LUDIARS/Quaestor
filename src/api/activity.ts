/**
 * GET /v1/activity?limit= — アクティビティログ (スマホのトップ用)。
 * @implements SPEC-MOBILE-HOME-002 (spec/feature/mobile-home.md)
 */

import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import { collectActivity } from "../services/activity-log.js";

const Query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

export function activityRouter(deps: { db: Database.Database }): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    c.header("Cache-Control", "no-store");
    return c.json({ items: collectActivity(deps.db, parsed.data.limit ?? 30) });
  });
  return app;
}
