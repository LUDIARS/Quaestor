import { Hono } from "hono";
import { z } from "zod";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ReceiptsRepo, OcrStatus } from "../db/receipts-repo.js";
import type { ReceiptStorage } from "../services/receipt-storage.js";
import type { OcrClient } from "../services/ocr-client.js";
import { runOcrFor } from "../services/ocr-runner.js";
import { ClaudeCodeOcr, detectClaudeCli, projectRoot } from "../services/claude-code-ocr.js";

const GeoSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  accuracy: z.number().optional(),
}).nullable().optional();

const CreateSchema = z.object({
  /** 高解像度 jpeg/png を base64 で送る。 multipart 対応は後段 */
  image_b64: z.string().min(1),
  /** unix sec、 省略時は now */
  captured_at: z.number().int().optional(),
  ext: z.enum(["jpg", "jpeg", "png"]).optional(),
  geo: GeoSchema,
  /** 検出器が返した bbox 等の context */
  metadata: z.record(z.unknown()).optional(),
});

const ListQuerySchema = z.object({
  status: z.enum(["pending", "processing", "done", "failed", "manual"]).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const OcrResultSchema = z.object({
  ocr_status: z.enum(["pending", "processing", "done", "failed", "manual"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  payee: z.string().max(500).nullable().optional(),
  total: z.number().int().nullable().optional(),
  items: z.array(z.object({
    name: z.string().min(1).max(500),
    price: z.number().int(),
    qty: z.number().int().optional(),
  })).nullable().optional(),
  ocr_raw: z.string().max(100_000).nullable().optional(),
});

export interface ReceiptsApiDeps {
  repo: ReceiptsRepo;
  storage: ReceiptStorage;
  /** OCR が disabled な環境 (key 未設定 / テスト) では undefined */
  ocr?: OcrClient;
}

export function receiptsRouter(deps: ReceiptsApiDeps): Hono {
  const app = new Hono();

  // POST /v1/receipts — captured frame を保存して pending エントリ作成
  // 投機的実行用 server-side dedup: 直近 30 秒で同一画像 hash があれば既存 id を返す
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const buf = Buffer.from(parsed.data.image_b64, "base64");
    if (buf.length === 0) return c.json({ error: "empty image" }, 400);
    if (buf.length > 25 * 1024 * 1024) return c.json({ error: "image too large (>25MB)" }, 413);

    const imageHash = createHash("sha1").update(buf).digest("hex");
    const existing = deps.repo.findRecentByImageHash(imageHash, 30);
    if (existing) {
      return c.json({
        receipt: existing,
        stored_size: 0,
        deduped: true,
      });
    }

    const ext = parsed.data.ext ?? "jpg";
    const capturedAt = parsed.data.captured_at ?? Math.floor(Date.now() / 1000);
    const meta = { ...(parsed.data.metadata ?? {}), image_hash: imageHash };
    const id = deps.repo.insert({
      captured_at: capturedAt,
      geo: parsed.data.geo ?? null,
      metadata: meta,
    });
    const saved = deps.storage.save(id, buf, capturedAt, ext);
    deps.repo.setImagePath(id, saved.relativePath);

    // stable capture (確定スキャン) は自動で Claude Code OCR を spawn する。
    // speculative は spawn しない (頻度多くて claude 起動が間に合わないため、 queue 経由で手動)。
    const kind = (meta as { kind?: string }).kind;
    let autoTriggered = false;
    if (kind === "stable" && !deps.ocr && detectClaudeCli()) {
      const port = Number(process.env.QUAESTOR_PORT ?? 17400);
      const baseUrl = `http://127.0.0.1:${port}`;
      const cco = new ClaudeCodeOcr({ backendBaseUrl: baseUrl, workingDir: projectRoot() });
      cco.triggerAsync(id).then((t) => {
        if (t.ok) deps.repo.setOcrResult(id, { ocr_status: "processing" });
      });
      autoTriggered = true;
    }

    return c.json({
      receipt: deps.repo.find(id),
      stored_size: saved.size,
      deduped: false,
      auto_triggered: autoTriggered,
    }, 201);
  });

  // GET /v1/receipts — list with filter
  app.get("/", (c) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const items = deps.repo.list(parsed.data);
    const total = deps.repo.count(parsed.data);
    return c.json({ items, total, limit: parsed.data.limit ?? 200, offset: parsed.data.offset ?? 0 });
  });

  // GET /v1/receipts/:id
  app.get("/:id", (c) => {
    const r = deps.repo.find(c.req.param("id"));
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ receipt: r });
  });

  // GET /v1/receipts/:id/image — 画像ファイルを返す
  app.get("/:id/image", (c) => {
    const r = deps.repo.find(c.req.param("id"));
    if (!r || !r.image_path) return c.json({ error: "not_found" }, 404);
    const buf = deps.storage.load(r.image_path);
    if (!buf) return c.json({ error: "image_missing" }, 404);
    const ext = r.image_path.split(".").pop()?.toLowerCase();
    const mime = ext === "png" ? "image/png" : "image/jpeg";
    return new Response(buf, { headers: { "content-type": mime } });
  });

  // PATCH /v1/receipts/:id/ocr — OCR 結果を上書き (v0.4 で OCR worker から呼ぶ)
  app.patch("/:id/ocr", async (c) => {
    const id = c.req.param("id");
    const r = deps.repo.find(id);
    if (!r) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = OcrResultSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    deps.repo.setOcrResult(id, parsed.data as Parameters<typeof deps.repo.setOcrResult>[1]);
    return c.json({ receipt: deps.repo.find(id) });
  });

  // DELETE /v1/receipts/:id
  app.delete("/:id", (c) => {
    const r = deps.repo.find(c.req.param("id"));
    if (!r) return c.json({ error: "not_found" }, 404);
    const ok = deps.repo.delete(c.req.param("id"));
    return c.json({ ok });
  });

  // POST /v1/receipts/:id/ocr/run — Anthropic vision に投げて構造化抽出 (sync)
  app.post("/:id/ocr/run", async (c) => {
    if (!deps.ocr) return c.json({ error: "ocr_disabled", message: "ANTHROPIC_API_KEY 未設定" }, 503);
    const id = c.req.param("id");
    const result = await runOcrFor(id, { receipts: deps.repo, storage: deps.storage, client: deps.ocr });
    if (!result.ok) return c.json({ ok: false, status: result.status, message: result.message }, 400);
    return c.json({ ok: true, status: result.status, receipt: deps.repo.find(id) });
  });

  // POST /v1/receipts/:id/ocr/claude-code — claude CLI を spawn して fire-and-forget で解析
  // 解析完了後、 claude 自身が PATCH /v1/receipts/:id/ocr で結果を書き戻す
  app.post("/:id/ocr/claude-code", async (c) => {
    const id = c.req.param("id");
    const r = deps.repo.find(id);
    if (!r) return c.json({ error: "not_found" }, 404);
    if (!detectClaudeCli()) {
      return c.json({ error: "claude_cli_disabled", message: "CLAUDE_CODE_OCR_DISABLE=1" }, 503);
    }

    // status=processing に遷移
    deps.repo.setOcrResult(id, { ocr_status: "processing" });

    const port = Number(process.env.QUAESTOR_PORT ?? 17400);
    const baseUrl = `http://127.0.0.1:${port}`;
    const ocr = new ClaudeCodeOcr({
      backendBaseUrl: baseUrl,
      workingDir: projectRoot(),
    });
    const triggered = await ocr.triggerAsync(id);
    if (!triggered.ok) {
      // spawn 失敗 → failed に戻す
      deps.repo.setOcrResult(id, {
        ocr_status: "failed",
        ocr_raw: JSON.stringify({ error: triggered.error ?? "spawn failed" }),
      });
      return c.json({ ok: false, error: triggered.error ?? "spawn failed" }, 500);
    }

    return c.json({
      ok: true,
      status: "processing",
      pid: triggered.pid,
      message: "claude CLI で解析中、 完了後に PATCH で結果書き戻し",
    }, 202);
  });

  return app;
}
