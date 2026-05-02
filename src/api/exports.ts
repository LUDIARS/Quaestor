import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ApportionmentRulesRepo } from "../db/apportionment-rules-repo.js";
import type { AccountCodesRepo } from "../db/account-codes-repo.js";
import { buildJournal } from "../services/journal.js";
import { buildJournalWorkbook } from "../services/excel-export.js";

const QuerySchema = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_no: z.coerce.number().int().min(1).optional(),
});

export interface ExportsApiDeps {
  db: Database.Database;
  rules: ApportionmentRulesRepo;
  accounts: AccountCodesRepo;
}

export function exportsRouter(deps: ExportsApiDeps): Hono {
  const app = new Hono();

  // GET /v1/exports/journal — 仕訳帳 Excel をストリームで返す
  app.get("/journal", async (c) => {
    const parsed = QuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const accountNames: Record<number, string> = {};
    for (const a of deps.accounts.list()) accountNames[a.code] = a.name;

    const entries = buildJournal(deps.db, deps.rules, {
      date_from: parsed.data.date_from,
      date_to: parsed.data.date_to,
      startNo: parsed.data.start_no ?? 1,
      accountNames,
    });
    const buf = await buildJournalWorkbook(entries);
    const filename = `quaestor-journal-${parsed.data.date_from ?? "all"}_${parsed.data.date_to ?? "all"}.xlsx`;
    return new Response(buf, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "x-quaestor-entries": String(entries.length),
      },
    });
  });

  // GET /v1/exports/journal/preview — JSON で entries を返す (UI プレビュー用)
  app.get("/journal/preview", (c) => {
    const parsed = QuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const accountNames: Record<number, string> = {};
    for (const a of deps.accounts.list()) accountNames[a.code] = a.name;

    const entries = buildJournal(deps.db, deps.rules, {
      date_from: parsed.data.date_from,
      date_to: parsed.data.date_to,
      startNo: parsed.data.start_no ?? 1,
      accountNames,
    });
    return c.json({ entries, count: entries.length });
  });

  return app;
}
