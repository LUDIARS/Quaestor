/**
 * OCR-GA エンドポイント。web が待機中に評価した OCR パラメータ個体を受けて
 * 集団を進化・永続する (PaddleOCR パラメータの遺伝的最適化)。
 *
 *  GET  /v1/ocr-ga/population?key=global   → 評価すべき現世代の個体
 *  POST /v1/ocr-ga/generation              → 評価結果で 1 世代進める
 */

import { Hono } from "hono";
import { z } from "zod";
import type { GaStore } from "../services/genetic.js";
import type { OcrGenome } from "../services/ocr-ga.js";

const GenomeSchema = z.object({
  detThresh: z.number(),
  boxThresh: z.number(),
  unclipRatio: z.number(),
  limitSideLen: z.number().int().positive(),
  useDilation: z.boolean(),
  dropScore: z.number(),
});

const GenerationSchema = z.object({
  key: z.string().max(64).optional(),
  evaluated: z.array(z.object({
    genome: GenomeSchema,
    fitness: z.number().min(0).max(1),
  })).max(64),
});

export interface OcrGaDeps {
  ga: GaStore<OcrGenome>;
}

export function ocrGaRouter(deps: OcrGaDeps): Hono {
  const app = new Hono();

  // GET /v1/ocr-ga/population — 評価対象の現世代個体
  app.get("/population", (c) => {
    const key = c.req.query("key") || "global";
    return c.json(deps.ga.population(key));
  });

  // POST /v1/ocr-ga/generation — 評価結果で進化 + 永続
  app.post("/generation", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = GenerationSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const key = parsed.data.key || "global";
    const res = deps.ga.recordGeneration(
      key,
      parsed.data.evaluated as Array<{ genome: OcrGenome; fitness: number }>,
    );
    return c.json({ ok: true, key, generation: res.generation, best: res.best });
  });

  return app;
}
