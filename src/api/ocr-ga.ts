/**
 * OCR-GA エンドポイント。
 *
 *  GET  /v1/ocr-ga/population?key=global|tag:<x> → 評価すべき現世代の個体
 *  GET  /v1/ocr-ga/best?tags=long,faded          → タグ優先の最良遺伝子 (無ければ global → 既定)
 *  GET  /v1/ocr-ga/status                        → 設定ページ「OCR 進化」カードの観測値
 *
 * 集団キーはラベル (`global` / `tag:<形状タグ>`) のみ。店舗別キーは廃止し、それ以外の
 * キー (旧 web の payee 由来キーなど) は global に丸める。
 *
 * 世代を進める経路は夜間バッチ (services/ocr-ga-bench) **だけ**。撮影時に web が
 * 世代を進めていた `POST /generation` は B-1 で撮影時評価ごと撤去した
 * (spec/feature/ocr-ga-evaluation.md SPEC-OCR-GA-EVAL-006)。撮影時は
 * `POST /v1/receipts/:id/detect` が best を引いて 1 回だけ検出し、採点結果は
 * 集団ではなく運用評価レコード (production-eval.jsonl) に残る。
 *
 * status の応答は `services/ocr-ga-bench/status-service.ts` が組み立てる。ここで値を
 * 触らないので、個人データ (店名 / 金額) が応答に混じる経路がこのファイルには無い。
 */

import { Hono, type Context } from "hono";
import { gaBenchSidecarUrlOf, loadAppConfig, type AppConfig } from "../services/app-config.js";
import type { GaStore } from "../services/genetic.js";
import { readOcrGaStatus } from "../services/ocr-ga-bench/status-service.js";
import { normalizeGaKey, resolveBestGenome, type OcrGenome } from "../services/ocr-ga.js";
import { HttpOcrSidecarClient, type OcrSidecarClient } from "../services/ocr-sidecar-client.js";
import { isDirectLoopbackRequest } from "../shared/local-request.js";

export interface OcrGaDeps {
  ga: GaStore<OcrGenome>;
  /** GA 永続ルート (status が bench-report.json / evolution.jsonl を読む)。既定は設定値 */
  gaRoot?: string;
  /** テスト用: 設定の読み方。既定は quaestor.config.json + env override */
  loadConfig?: () => AppConfig;
  /** テスト用: `/health` を叩く sidecar。既定は gaBench.sidecarUrl (無ければ運用 sidecar) */
  sidecarFor?: (url: string) => Pick<OcrSidecarClient, "baseUrl" | "health">;
  /** テスト用: 現在時刻 (警告の 48 時間判定) */
  now?: () => number;
  /** status はローカルの観測情報を含むため、既定では直接の loopback だけに返す */
  canReadStatus?: (context: Context) => boolean;
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

  /**
   * GET /v1/ocr-ga/status — 「OCR 進化」カードの観測値。
   * sidecar 不達は 500 にせず `sidecar.reachable:false` + 警告として返す
   * (死んでいることが画面で分かるのが目的)。
   *
   * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
   */
  app.get("/status", async (c) => {
    if (!(deps.canReadStatus ?? isDirectLoopbackRequest)(c)) {
      return c.json({ error: "direct loopback access required" }, 403);
    }
    c.header("Cache-Control", "no-store");
    const config = (deps.loadConfig ?? loadAppConfig)();
    const sidecarUrl = gaBenchSidecarUrlOf(config);
    const sidecar = deps.sidecarFor ? deps.sidecarFor(sidecarUrl) : statusSidecarClient(sidecarUrl);
    return c.json(await readOcrGaStatus({
      gaRoot: deps.gaRoot ?? config.training.gaRoot,
      gaBench: config.training.gaBench,
      sidecar,
      now: deps.now,
    }));
  });

  return app;
}

/** 不正 URL も status の 500 にはせず、probeSidecar が不達として扱える client にする。 */
function statusSidecarClient(baseUrl: string): Pick<OcrSidecarClient, "baseUrl" | "health"> {
  try {
    return new HttpOcrSidecarClient({ baseUrl });
  } catch {
    return {
      baseUrl,
      health: async () => { throw new Error("invalid sidecar URL"); },
    };
  }
}
