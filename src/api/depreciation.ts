/**
 * 減価償却 API (/v1/depreciation)。 固定資産台帳 CRUD / 年度の償却表 / 投影 / 仕訳計上 / 償却率表。
 * @implements SPEC-DEPRECIATION-003 (spec/feature/depreciation.md)
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AccountCodesRepo } from "../db/account-codes-repo.js";
import { DEFAULT_ASSET_CODE, DEFAULT_EXPENSE_CODE, type FixedAssetsRepo } from "../db/fixed-assets-repo.js";
import type { DepreciationSchedule } from "../services/depreciation/depreciation-schedule.js";
import type { DepreciationPosting } from "../services/depreciation/depreciation-posting.js";
import { DEPRECIATION_METHODS, rateTable, resolveFamily } from "../services/depreciation/rate-table.js";
import { isIsoDate } from "../shared/text.js";

const IsoDate = z.string().refine(isIsoDate, "invalid date");

const AssetFields = z.object({
  name: z.string().min(1).max(200),
  quantity: z.string().max(100).nullable().optional(),
  acquired_on: IsoDate,
  cost: z.number().int().nonnegative(),
  method: z.enum(DEPRECIATION_METHODS),
  useful_life: z.number().int().min(0).max(50).optional(),
  business_ratio: z.number().min(0).max(1).optional(),
  asset_code: z.number().int().min(1).max(9999).optional(),
  expense_code: z.number().int().min(1).max(9999).optional(),
  opening_book_value: z.number().int().nonnegative().nullable().optional(),
  opening_year: z.number().int().min(1900).max(2999).nullable().optional(),
  revised_cost: z.number().int().nonnegative().nullable().optional(),
  disposed_on: IsoDate.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

type AssetInput = z.infer<typeof AssetFields>;

function refineAsset(v: AssetInput, ctx: z.RefinementCtx): void {
  const needsLife = v.method !== "lump_sum_3y" && v.method !== "immediate";
  if (needsLife && !(v.useful_life && v.useful_life >= 2 && v.useful_life <= 50)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "useful_life must be 2..50 for this method", path: ["useful_life"] });
  }
  if ((v.opening_year == null) !== (v.opening_book_value == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "opening_year and opening_book_value must be set together", path: ["opening_year"] });
  }
  const acquiredYear = Number(v.acquired_on.slice(0, 4));
  if (v.opening_year != null && v.opening_year < acquiredYear) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "opening_year must not precede acquisition", path: ["opening_year"] });
  }
  if (v.opening_book_value != null && v.opening_book_value > v.cost) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "opening_book_value must not exceed cost", path: ["opening_book_value"] });
  }
  if (v.revised_cost != null && v.revised_cost > v.cost) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "revised_cost must not exceed cost", path: ["revised_cost"] });
  }
  if (v.revised_cost != null && (v.method !== "declining_balance" || v.opening_year == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "revised_cost requires declining_balance and an opening balance", path: ["revised_cost"] });
  }
  if (v.disposed_on != null && v.disposed_on < v.acquired_on) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "disposed_on must not precede acquisition", path: ["disposed_on"] });
  }
  const disposedYear = v.disposed_on == null ? null : Number(v.disposed_on.slice(0, 4));
  if (v.opening_year != null && disposedYear != null && v.opening_year > disposedYear) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "opening_year must not follow disposal", path: ["opening_year"] });
  }
}

const AssetCreate = AssetFields.superRefine(refineAsset);
const AssetUpdate = AssetFields.partial();

const AUTO_ASSET_CODES = new Set([111, 112, 113, 114, 115, 116]);

function accountError(accounts: AccountCodesRepo, input: AssetInput): string | null {
  const assetCode = input.asset_code ?? DEFAULT_ASSET_CODE;
  const expenseCode = input.expense_code ?? DEFAULT_EXPENSE_CODE;
  const asset = accounts.find(assetCode);
  if (!asset && !AUTO_ASSET_CODES.has(assetCode)) return `asset_code ${assetCode} does not exist`;
  if (asset && asset.kind !== "asset") return `asset_code ${assetCode} is not an asset account`;
  const expense = accounts.find(expenseCode);
  if (!expense && expenseCode !== DEFAULT_EXPENSE_CODE) return `expense_code ${expenseCode} does not exist`;
  if (expense && expense.kind !== "expense") return `expense_code ${expenseCode} is not an expense account`;
  return null;
}

export interface DepreciationApiDeps {
  assets: FixedAssetsRepo;
  accounts: AccountCodesRepo;
  schedule: DepreciationSchedule;
  posting: DepreciationPosting;
}

function yearOf(param: string): number | null {
  if (!/^\d{4}$/.test(param)) return null;
  const y = Number(param);
  return y >= 1900 && y <= 2999 ? y : null;
}

function idOf(param: string): number | null {
  if (!/^[1-9]\d*$/.test(param)) return null;
  const id = Number(param);
  return Number.isSafeInteger(id) ? id : null;
}

export function depreciationRouter(deps: DepreciationApiDeps): Hono {
  const app = new Hono();

  app.get("/rates", (c) => c.json({ methods: DEPRECIATION_METHODS, rates: rateTable() }));

  app.get("/assets", (c) => c.json({
    items: deps.assets.list().map((a) => ({ ...a, family: resolveFamily(a.method, a.acquired_on) })),
  }));

  app.post("/assets", async (c) => {
    const parsed = AssetCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const invalidAccount = accountError(deps.accounts, parsed.data);
    if (invalidAccount) return c.json({ error: invalidAccount }, 400);
    const id = deps.assets.insert(parsed.data);
    return c.json({ asset: deps.assets.find(id) }, 201);
  });

  app.get("/assets/:id", (c) => {
    const id = idOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const a = deps.assets.find(id);
    if (!a) return c.json({ error: "not_found" }, 404);
    return c.json({ asset: a });
  });

  app.patch("/assets/:id", async (c) => {
    const id = idOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const parsed = AssetUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const before = deps.assets.find(id);
    if (!before) return c.json({ error: "not_found" }, 404);
    // 更新後の全体像で再検証 (耐用年数と方法の整合)
    const merged = AssetCreate.safeParse({ ...before, ...parsed.data });
    if (!merged.success) return c.json({ error: merged.error.message }, 400);
    const invalidAccount = accountError(deps.accounts, merged.data);
    if (invalidAccount) return c.json({ error: invalidAccount }, 400);
    deps.assets.update(id, parsed.data);
    return c.json({ asset: deps.assets.find(id) });
  });

  app.delete("/assets/:id", (c) => {
    const id = idOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    if (!deps.assets.delete(id)) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/assets/:id/projection", (c) => {
    const id = idOf(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);
    const p = deps.schedule.projection(id);
    if (!p) return c.json({ error: "not_found" }, 404);
    return c.json(p);
  });

  app.get("/:year/schedule", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    return c.json(deps.schedule.forYear(y));
  });

  app.post("/:year/post", (c) => {
    const y = yearOf(c.req.param("year"));
    if (y === null) return c.json({ error: "invalid year" }, 400);
    return c.json(deps.posting.post(y));
  });

  return app;
}
