import { Hono } from "hono";
import { z } from "zod";
import { Buffer } from "node:buffer";
import * as registry from "../importers/registry.js";
import { parseSmbcBankPdf } from "../importers/smbc-bank-pdf.js";
import type { ImportsRepo } from "../db/imports-repo.js";
import type { TransactionsRepo } from "../db/transactions-repo.js";
import type { ImporterResult, SourceKind } from "../shared/types.js";

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
}

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

    const picked = parsed.data.brand
      ? { brand: parsed.data.brand, importer: registry.get(parsed.data.brand) }
      : registry.detect(buf);
    if (!picked || !picked.importer) {
      return c.json({ error: "no importer matched", supported_brands: registry.brands() }, 422);
    }

    // smbc-bank は async (PDF パース) 専用 path
    let result: ImporterResult;
    if (picked.brand === "smbc-bank") {
      result = await parseSmbcBankPdf(buf, { account: parsed.data.account });
    } else if (picked.importer) {
      result = picked.importer.parse(buf, { account: parsed.data.account });
    } else {
      return c.json({ error: "no importer matched", supported_brands: registry.brands() }, 422);
    }
    const source: SourceKind = sourceForBrand(picked.brand);

    const importId = deps.imports.insert({
      source,
      brand: picked.brand,
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

    return c.json({
      import_id: importId,
      brand: picked.brand,
      account: result.account,
      parsed: result.rows.length,
      inserted: bulk.inserted,
      duplicates: bulk.duplicates,
      warnings: result.warnings,
    });
  });

  return app;
}

function sourceForBrand(brand: string): SourceKind {
  if (brand === "ufj" || brand === "smbc" || brand === "rakuten") return "credit-card";
  if (brand === "amazon-order-history") return "amazon";
  if (brand === "smbc-bank" || brand === "ufj-bank") return "bank";
  return "credit-card";
}
