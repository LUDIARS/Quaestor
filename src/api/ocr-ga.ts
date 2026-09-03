/**
 * OCR-GA エンドポイント。
 *
 *  GET  /v1/ocr-ga/population?key=global|tag:<x> → 評価すべき現世代の個体
 *  POST /v1/ocr-ga/generation                    → 評価結果で 1 世代進める
 *  GET  /v1/ocr-ga/best?tags=long,faded          → タグ優先の最良遺伝子 (無ければ global → 既定)
 *
 * 集団キーはラベル (`global` / `tag:<形状タグ>`) のみ。店舗別キーは廃止し、それ以外の
 * キー (旧 web の payee 由来キーなど) は global に丸める。世代を進める本経路は夜間バッチ
 * (services/ocr-ga-bench) で、POST /generation は互換のために残している。
 */

import { Hono } from "hono";
import { z } from "zod";
import { StaleGaGenerationError, type GaStore } from "../services/genetic.js";
import { normalizeGaKey, resolveBestGenome, type OcrGenome } from "../services/ocr-ga.js";

const GenomeSchema = z.object({
  detThresh: z.number().min(0.2).max(0.5),
  boxThresh: z.number().min(0.4).max(0.85),
  unclipRatio: z.number().min(1.3).max(2.6),
  limitSideLen: z.union([z.literal(736), z.literal(960), z.literal(1280), z.literal(1600)]),
  useDilation: z.boolean(),
  dropScore: z.number().min(0.3).max(0.7),
});

const GenerationSchema = z.object({
  key: z.string().max(64).optional(),
  expectedGeneration: z.number().int().nonnegative().optional(),
  evaluated: z.array(z.object({
    genome: GenomeSchema,
    fitness: z.number().min(0).max(1),
  })).min(1).max(64),
});

export interface OcrGaDeps {
  ga: GaStore<OcrGenome>;
}

/** @implements SPEC-OCR-GA-EVAL-004 (spec/feature/ocr-ga-evaluation.md) */
export function ocrGaRouter(deps: OcrGaDeps): Hono {
  const app = new Hono();

  // GET /v1/ocr-ga/population — 評価対象の現世代個体 (ラベルキー以外は global)
  app.get("/population", (c) => {
    const key = normalizeGaKey(c.req.query("key"));
    return c.json(deps.ga.population(key));
  });

  // POST /v1/ocr-ga/generation — 評価結果で進化 + 永続 (payee 由来キーは受け付けず global)
  app.post("/generation", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = GenerationSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const key = normalizeGaKey(parsed.data.key);
    let res;
    try {
      res = deps.ga.recordGeneration(
        key,
        parsed.data.evaluated as Array<{ genome: OcrGenome; fitness: number }>,
        { expectedGeneration: parsed.data.expectedGeneration },
      );
    } catch (error: unknown) {
      if (error instanceof StaleGaGenerationError) {
        return c.json({ error: error.message, generation: error.actual }, 409);
      }
      throw error;
    }
    return c.json({ ok: true, key, generation: res.generation, best: res.best });
  });

  // GET /v1/ocr-ga/best?tags=a,b — タグ優先 → global → 既定遺伝子
  app.get("/best", (c) => {
    const tags = (c.req.query("tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return c.json(resolveBestGenome(deps.ga, tags));
  });

  return app;
}
