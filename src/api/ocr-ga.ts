/**
 * OCR-GA エンドポイント。
 *
 *  GET  /v1/ocr-ga/population?key=global|tag:<x> → 評価すべき現世代の個体
 *  GET  /v1/ocr-ga/best?tags=long,faded          → タグ優先の最良遺伝子 (無ければ global → 既定)
 *
 * 集団キーはラベル (`global` / `tag:<形状タグ>`) のみ。店舗別キーは廃止し、それ以外の
 * キー (旧 web の payee 由来キーなど) は global に丸める。
 *
 * 世代を進める経路は夜間バッチ (services/ocr-ga-bench) **だけ**。撮影時に web が
 * 世代を進めていた `POST /generation` は B-1 で撮影時評価ごと撤去した
 * (spec/feature/ocr-ga-evaluation.md SPEC-OCR-GA-EVAL-006)。撮影時は
 * `POST /v1/receipts/:id/detect` が best を引いて 1 回だけ検出し、採点結果は
 * 集団ではなく運用評価レコード (production-eval.jsonl) に残る。
 */

import { Hono } from "hono";
import type { GaStore } from "../services/genetic.js";
import { normalizeGaKey, resolveBestGenome, type OcrGenome } from "../services/ocr-ga.js";

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
