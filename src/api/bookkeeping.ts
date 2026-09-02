/**
 * 簿記 API (/v1/bookkeeping)。 仕訳帳の再生成・手動仕訳・精算表・元帳・月別・決算書・ブック出力・xlsx 取込。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-001 (spec/feature/household-bookkeeping.md)
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-003 (spec/feature/household-bookkeeping.md)
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-004 (spec/feature/household-bookkeeping.md)
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { JournalEntriesRepo } from "../db/journal-entries-repo.js";
import type { AccountCodesRepo } from "../db/account-codes-repo.js";
import type { ReceiptsRepo } from "../db/receipts-repo.js";
import type { JournalLedger } from "../services/bookkeeping/journal-ledger.js";
import type { BookkeepingReports } from "../services/bookkeeping/bookkeeping-reports.js";
import type { JournalImportService } from "../services/bookkeeping/journal-import.js";
import { parseJournalWorkbook } from "../services/bookkeeping/journal-xlsx-import.js";
import { buildManualEntries, MANUAL_TEMPLATES } from "../services/bookkeeping/manual-entries.js";
import type { HouseholdClassifier } from "../services/household/household-classifier.js";
import { isIsoDate } from "../shared/text.js";
import { MAX_XLSX_BYTES } from "../services/bookkeeping/xlsx-archive-limits.js";

const MAX_IMPORT_JSON_BYTES = Math.ceil(MAX_XLSX_BYTES / 3) * 4 + 1_024;

const ListQuery = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  code: z.coerce.number().int().min(1).optional(),
  origin: z.enum(["transaction", "manual", "imported"]).optional(),
  household_category_id: z.coerce.number().int().optional(),
});

const ManualSchema = z.object({
  template: z.enum(MANUAL_TEMPLATES),
  entry_date: z.string().refine(isIsoDate, "invalid calendar date"),
  amount: z.number().int().positive(),
  description: z.string().min(1).max(200),
  debit_code: z.number().int().positive().optional(),
  credit_code: z.number().int().positive().optional(),
  household_category_id: z.number().int().nullable().optional(),
  receipt_id: z.string().nullable().optional(),
});

const PatchSchema = z.object({
  entry_date: z.string().refine(isIsoDate, "invalid calendar date").optional(),
  debit_code: z.number().int().positive().optional(),
  debit_amount: z.number().int().nonnegative().optional(),
  credit_code: z.number().int().positive().optional(),
  credit_amount: z.number().int().nonnegative().optional(),
  description: z.string().max(200).optional(),
  payment: z.number().int().nonnegative().optional(),
  rate: z.number().min(0).max(1).optional(),
  household_category_id: z.number().int().nullable().optional(),
  locked: z.boolean().optional(),
});

const OpeningSchema = z.object({
  balances: z.array(z.object({ code: z.number().int().positive(), amount: z.number().int() })).max(500),
}).refine((value) => new Set(value.balances.map((b) => b.code)).size === value.balances.length, "duplicate account code");

const ImportSchema = z.object({
  content_b64: z.string().min(1).max(Math.ceil(MAX_XLSX_BYTES / 3) * 4),
  replace: z.boolean().optional(),
  import_accounts: z.boolean().optional(),
});

export interface BookkeepingApiDeps {
  accounts: AccountCodesRepo;
  receipts: ReceiptsRepo;
  entries: JournalEntriesRepo;
  ledger: JournalLedger;
  reports: BookkeepingReports;
  importer: JournalImportService;
  classifier: HouseholdClassifier;
}

function yearOf(param: string): number | null {
  if (!/^\d{4}$/.test(param)) return null;
  const y = Number(param);
  return Number.isInteger(y) && y >= 1900 && y <= 2999 ? y : null;
}

function validEntryCodes(accounts: AccountCodesRepo, debitCode: number, creditCode: number): boolean {
  return accounts.find(debitCode) !== undefined && accounts.find(creditCode) !== undefined;
}

function decodeWorkbookBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length <= MAX_XLSX_BYTES ? decoded : null;
}

export function bookkeepingRouter(deps: BookkeepingApiDeps): Hono {
  const app = new Hono();

  app.get("/years", (c) => c.json({ years: deps.entries.years() }));

  app.post("/:year/rebuild", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    return c.json(deps.ledger.rebuild(y));
  });

  app.get("/:year/journal", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    const parsed = ListQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const items = deps.entries.listYear(y, parsed.data).map((e) => ({
      ...e,
      household_category_name: deps.classifier.categoryName(e.household_category_id),
    }));
    return c.json({ year: y, items });
  });

  app.post("/:year/journal", async (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = ManualSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!parsed.data.entry_date.startsWith(`${y}-`)) return c.json({ error: "entry date is outside fiscal year" }, 400);
    if (parsed.data.household_category_id != null && deps.classifier.categoryName(parsed.data.household_category_id) === null) {
      return c.json({ error: "unknown household category" }, 400);
    }
    if (parsed.data.receipt_id != null && !deps.receipts.find(parsed.data.receipt_id)) {
      return c.json({ error: "unknown receipt" }, 400);
    }
    let inputs;
    try {
      inputs = buildManualEntries({ ...parsed.data, fiscal_year: y });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (inputs.some((i) => !validEntryCodes(deps.accounts, i.debit_code, i.credit_code))) {
      return c.json({ error: "unknown account code" }, 400);
    }
    const ids = deps.entries.insertMany(inputs);
    deps.entries.renumber(y);
    return c.json({ entries: ids.map((id) => deps.entries.find(id)) }, 201);
  });

  app.patch("/journal/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const before = deps.entries.find(id);
    if (!before) return c.json({ error: "not_found" }, 404);
    const entryDate = parsed.data.entry_date ?? before.entry_date;
    if (!entryDate.startsWith(`${before.fiscal_year}-`)) return c.json({ error: "entry date is outside fiscal year" }, 400);
    const debitCode = parsed.data.debit_code ?? before.debit_code;
    const creditCode = parsed.data.credit_code ?? before.credit_code;
    if (!validEntryCodes(deps.accounts, debitCode, creditCode)) return c.json({ error: "unknown account code" }, 400);
    const debitAmount = parsed.data.debit_amount ?? before.debit_amount;
    const creditAmount = parsed.data.credit_amount ?? before.credit_amount;
    if (debitAmount !== creditAmount) return c.json({ error: "journal entry must balance" }, 400);
    if (parsed.data.household_category_id != null && deps.classifier.categoryName(parsed.data.household_category_id) === null) {
      return c.json({ error: "unknown household category" }, 400);
    }
    // 手で直した自動生成行は次の rebuild で消えないよう既定で locked にする
    const locked = parsed.data.locked ?? (before.origin === "transaction" ? true : undefined);
    const ok = deps.entries.update(id, { ...parsed.data, locked });
    if (!ok) return c.json({ error: "not_found" }, 404);
    if (parsed.data.entry_date) deps.entries.renumber(before.fiscal_year);
    return c.json({ entry: deps.entries.find(id) });
  });

  app.delete("/journal/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const before = deps.entries.find(id);
    if (!before) return c.json({ error: "not_found" }, 404);
    deps.entries.delete(id);
    deps.entries.renumber(before.fiscal_year);
    return c.json({ ok: true });
  });

  app.get("/:year/opening", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    return c.json({ year: y, balances: deps.reports.openingList(y) });
  });

  app.put("/:year/opening", async (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = OpeningSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const invalid = parsed.data.balances.find((b) => {
      const account = deps.accounts.find(b.code);
      return !account || (account.kind !== "asset" && account.kind !== "liability");
    });
    if (invalid) return c.json({ error: `invalid balance-sheet account: ${invalid.code}` }, 400);
    const n = deps.reports.setOpening(y, parsed.data.balances);
    return c.json({ year: y, saved: n, balances: deps.reports.openingList(y) });
  });

  app.get("/:year/trial-balance", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    return c.json({ year: y, ...deps.reports.trialBalance(y) });
  });

  app.get("/:year/ledger/:code", (c) => {
    const y = yearOf(c.req.param("year"));
    const code = parseInt(c.req.param("code"), 10);
    if (y === null || Number.isNaN(code)) return c.json({ error: "invalid year or code" }, 400);
    const ledger = deps.reports.ledger(y, code);
    if (!ledger) return c.json({ error: "unknown account code" }, 404);
    return c.json({ year: y, ...ledger });
  });

  app.get("/:year/monthly", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    return c.json({ year: y, ...deps.reports.monthly(y) });
  });

  app.get("/:year/report", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    return c.json({ year: y, ...deps.reports.report(y) });
  });

  app.get("/:year/workbook.xlsx", async (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    const buf = await deps.reports.workbook(y);
    return new Response(buf, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="quaestor-bookkeeping-${y}.xlsx"`,
      },
    });
  });

  // POST /v1/bookkeeping/import-journal { content_b64 } — エクセル簿記の仕訳帳ブックを取り込む (年度はブックの日付から)
  app.post("/import-journal", bodyLimit({
    maxSize: MAX_IMPORT_JSON_BYTES,
    onError: (c) => c.json({ error: "workbook payload too large" }, 413),
  }), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ImportSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const workbookBuffer = decodeWorkbookBase64(parsed.data.content_b64);
    if (!workbookBuffer) return c.json({ error: "invalid workbook encoding" }, 400);
    let workbook;
    try {
      workbook = await parseJournalWorkbook(workbookBuffer);
    } catch (e: unknown) {
      return c.json({ error: `parse_failed: ${(e as Error).message}` }, 422);
    }
    let result;
    try {
      result = deps.importer.importParsed(workbook, {
        replace: parsed.data.replace,
        import_accounts: parsed.data.import_accounts,
      });
    } catch (e: unknown) {
      return c.json({ error: `import_failed: ${(e as Error).message}` }, 422);
    }
    return c.json({ ...result, header_row: workbook.header_row, skipped_rows: workbook.skipped });
  });

  return app;
}
