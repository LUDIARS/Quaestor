import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { Buffer } from "node:buffer";
import * as registry from "../importers/registry.js";
import { parseSmbcBankPdf } from "../importers/smbc-bank-pdf.js";
import { parseWithProfile, detectProfile } from "../importers/profile-csv.js";
import type { ImportsRepo } from "../db/imports-repo.js";
import type { TransactionsRepo } from "../db/transactions-repo.js";
import type { StatementProfilesRepo } from "../db/statement-profiles-repo.js";
import type { ImporterResult, SourceKind } from "../shared/types.js";
import type { SmartImporter, SmartImportResult } from "../services/smart-import.js";
import type { ReceiptIntake } from "../services/receipt-intake.js";

const PostBodySchema = z.object({
  brand: z.string().optional(),       // 省略時は auto-detect
  account: z.string().optional(),
  filename: z.string().optional(),
  /** 中身を base64 で投げる。 multipart/form-data 対応は v0.x 以降 */
  content_b64: z.string().min(1),
});

export interface ImportsApiDeps {
  imports: ImportsRepo;
  txs: TransactionsRepo;
  /** スマート import (vision / text) 用、 OCR と同じく省略可 */
  smart?: SmartImporter;
  /** 外部登録された明細プロファイル (列マッピング importer)。 省略可 */
  profiles?: StatementProfilesRepo;
  /**
   * 取込後の自動突合。 レシートが先に投入済なら、 取引が入ったこの時点で成立させる。
   * 未設定なら突合は Reconcile 画面の手動 auto-match のみ。
   */
  intake?: ReceiptIntake;
}

const SmartScreenshotSchema = z.object({
  image_b64: z.string().min(1),
  ext: z.enum(["jpg", "jpeg", "png"]).default("jpg"),
  account: z.string().optional(),
});

const SmartTextSchema = z.object({
  text: z.string().min(10).max(50_000),
  account: z.string().optional(),
});

export function importsRouter(deps: ImportsApiDeps): Hono {
  const app = new Hono();

  // GET /v1/imports — 取込履歴
  app.get("/", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
    return c.json({ items: deps.imports.list(limit) });
  });

  // POST /v1/imports — CSV を取込
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PostBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const buf = Buffer.from(parsed.data.content_b64, "base64");
    if (buf.length === 0) return c.json({ error: "empty content" }, 400);

    // dispatch: built-in importer (UFJ/SMBC/Amazon) → smbc-bank(PDF) → 登録済 profile の順。
    // brand 指定なら明示解決、 未指定なら auto-detect (built-in 優先、 次に profile)。
    const account = parsed.data.account;
    let result: ImporterResult;
    let brandUsed: string;
    let source: SourceKind;

    if (parsed.data.brand) {
      const brand = parsed.data.brand;
      if (brand === "smbc-bank") {
        result = await parseSmbcBankPdf(buf, { account });
        source = "bank";
        brandUsed = brand;
      } else if (registry.get(brand)) {
        result = registry.get(brand)!.parse(buf, { account });
        source = sourceForBrand(brand);
        brandUsed = brand;
      } else {
        const profile = deps.profiles?.findByBrand(brand);
        if (!profile) return c.json({ error: "no importer matched", supported_brands: supportedBrands(deps) }, 422);
        result = parseWithProfile(profile, buf, { account });
        source = profile.source;
        brandUsed = profile.brand;
      }
    } else {
      const det = registry.detect(buf);
      if (det) {
        result = det.brand === "smbc-bank"
          ? await parseSmbcBankPdf(buf, { account })
          : det.importer.parse(buf, { account });
        source = det.brand === "smbc-bank" ? "bank" : sourceForBrand(det.brand);
        brandUsed = det.brand;
      } else {
        const profile = deps.profiles ? detectProfile(deps.profiles.listEnabled(), buf) : null;
        if (!profile) return c.json({ error: "no importer matched", supported_brands: supportedBrands(deps) }, 422);
        result = parseWithProfile(profile, buf, { account });
        source = profile.source;
        brandUsed = profile.brand;
      }
    }

    const importId = deps.imports.insert({
      source,
      brand: brandUsed,
      account: result.account,
      filename: parsed.data.filename ?? null,
      metadata: { warnings: result.warnings, parsed_rows: result.rows.length },
    });

    const inputs = result.rows.map((row) => ({
      ...row,
      source,
      import_id: importId,
    }));
    const bulk = deps.txs.insertBulk(inputs);
    const reconciled = bulk.inserted > 0 ? deps.intake?.afterTransactionsImported() : undefined;

    return c.json({
      import_id: importId,
      auto_reconciled: reconciled?.matched.length ?? 0,
      brand: brandUsed,
      account: result.account,
      parsed: result.rows.length,
      inserted: bulk.inserted,
      duplicates: bulk.duplicates,
      warnings: result.warnings,
    });
  });

  // POST /v1/imports/smart-screenshot — クレカ/銀行明細のスクショから vision で抽出
  app.post("/smart-screenshot", async (c) => {
    if (!deps.smart) return c.json({ error: "smart import disabled (ANTHROPIC_API_KEY 未設定)" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = SmartScreenshotSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const buf = Buffer.from(parsed.data.image_b64, "base64");
    if (buf.length === 0) return c.json({ error: "empty image" }, 400);
    const mime: "image/jpeg" | "image/png" = parsed.data.ext === "png" ? "image/png" : "image/jpeg";
    return await persistSmartResult(c, deps, await deps.smart.fromScreenshot(buf, mime, parsed.data.account));
  });

  // POST /v1/imports/smart-text — クレカ/銀行明細のコピペテキストから抽出
  app.post("/smart-text", async (c) => {
    if (!deps.smart) return c.json({ error: "smart import disabled (ANTHROPIC_API_KEY 未設定)" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = SmartTextSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return await persistSmartResult(c, deps, await deps.smart.fromText(parsed.data.text, parsed.data.account));
  });

  return app;
}

/** @implements SPEC-RECEIPT-AUTO-INTAKE-002 (spec/feature/receipt-auto-intake.md) */
async function persistSmartResult(
  c: Context,
  deps: ImportsApiDeps,
  result: SmartImportResult,
): Promise<Response> {
  const importId = deps.imports.insert({
    source: result.source,
    brand: result.brand,
    account: result.account,
    filename: null,
    metadata: { warnings: result.warnings, parsed_rows: result.rows.length, smart: true },
  });
  const inputs = result.rows.map((row) => ({ ...row, source: result.source, import_id: importId }));
  const bulk = deps.txs.insertBulk(inputs);
  const reconciled = bulk.inserted > 0 ? deps.intake?.afterTransactionsImported() : undefined;
  return c.json({
    import_id: importId,
    auto_reconciled: reconciled?.matched.length ?? 0,
    brand: result.brand,
    account: result.account,
    parsed: result.rows.length,
    inserted: bulk.inserted,
    duplicates: bulk.duplicates,
    warnings: result.warnings,
  });
}

/** built-in brand + 登録済 profile brand を併せたサポート一覧 (422 のヒント用) */
function supportedBrands(deps: ImportsApiDeps): string[] {
  const profileBrands = deps.profiles?.list().map((p) => p.brand) ?? [];
  return [...registry.brands(), ...profileBrands];
}

function sourceForBrand(brand: string): SourceKind {
  if (brand === "ufj" || brand === "smbc" || brand === "rakuten") return "credit-card";
  if (brand === "amazon-order-history") return "amazon";
  if (brand === "smbc-bank" || brand === "ufj-bank") return "bank";
  return "credit-card";
}
