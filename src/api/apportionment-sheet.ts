/**
 * 按分シート API (/v1/apportionment-sheet)。 観測の再構築 / シート取得 / ルール生成 (dry-run → apply)。
 *
 * @implements SPEC-APPORTIONMENT-SHEET-002 (spec/feature/household-bookkeeping.md)
 * @implements SPEC-APPORTIONMENT-SHEET-001 (spec/feature/household-bookkeeping.md)
 */

import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ApportionmentObservationsRepo } from "../db/apportionment-observations-repo.js";
import type { ApportionmentRulesRepo } from "../db/apportionment-rules-repo.js";
import type { ObservationCollector } from "../services/apportionment-sheet/observation-collector.js";
import { buildApportionmentSheet, collectYearSpend } from "../services/apportionment-sheet/sheet-builder.js";
import { synthesizeRules } from "../services/apportionment-sheet/rule-synthesizer.js";

const SheetQuery = z.object({
  year: z.coerce.number().int().min(1900).max(2999).optional(),
  status: z.enum(["match", "differs", "proposal", "unknown"]).optional(),
});

const SynthesizeBody = z.object({
  year: z.number().int().min(1900).max(2999).optional(),
  dry_run: z.boolean().default(true),
  payees: z.array(z.string().min(1)).max(2000).optional(),
  min_occurrences: z.number().int().min(1).optional(),
  override: z.boolean().optional(),
});

export interface ApportionmentSheetApiDeps {
  db: Database.Database;
  observations: ApportionmentObservationsRepo;
  rules: ApportionmentRulesRepo;
  collector: ObservationCollector;
  today?: () => string;
}

export function apportionmentSheetRouter(deps: ApportionmentSheetApiDeps): Hono {
  const app = new Hono();
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  const sheet = (year: number) => buildApportionmentSheet(deps.observations.list(), deps.rules, collectYearSpend(deps.db, year));

  app.post("/collect", (c) => c.json(deps.collector.rebuildLedger()));

  app.get("/", (c) => {
    const parsed = SheetQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const year = parsed.data.year ?? Number(today().slice(0, 4));
    let rows = sheet(year);
    if (parsed.data.status) rows = rows.filter((r) => r.status === parsed.data.status);
    const counts = rows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
    return c.json({ year, observations: deps.observations.count(), counts, rows });
  });

  app.post("/synthesize", async (c) => {
    const parsed = SynthesizeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const year = parsed.data.year ?? Number(today().slice(0, 4));
    const result = synthesizeRules(sheet(year), deps.rules, {
      dry_run: parsed.data.dry_run,
      payees: parsed.data.payees,
      min_occurrences: parsed.data.min_occurrences,
      override: parsed.data.override,
      today: today(),
    });
    return c.json({ year, ...result });
  });

  return app;
}
