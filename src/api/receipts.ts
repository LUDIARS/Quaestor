import { Hono } from "hono";
import { z } from "zod";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ReceiptsRepo, OcrStatus } from "../db/receipts-repo.js";
import type { ReceiptStorage } from "../services/receipt-storage.js";
import type { OcrClient } from "../services/ocr-client.js";
import { runOcrFor } from "../services/ocr-runner.js";
import { ClaudeCodeOcr, detectClaudeCli, projectRoot } from "../services/claude-code-ocr.js";
import type { TrainingDataset } from "../services/training-dataset.js";
import { recordDetection } from "../services/detection-record.js";
import type { DiffEvaluator } from "../services/detection-diff-evaluator.js";
import type { ReceiptDetectService } from "../services/receipt-detect/detect-service.js";
import type { ReceiptIntake } from "../services/receipt-intake.js";
import { commitReceipt, commitReasonCode, kindBlockMessage } from "../services/receipt-commit.js";
import type { KindDestinations } from "../services/receipt-kind-destinations.js";
import { applyLlmLabels, applyManualLabels, normalizeLlmLabels, MAX_SAMPLE_REASON } from "../services/receipt-labels.js";
import { DOC_KINDS, SAMPLE_ROLES } from "../shared/document-kinds.js";

/**
 * 同一 receipt への OCR 起動 throttle。 2 秒内の再起動 (auto + 手動 + claude-code) は skip。
 * Anthropic / Claude CLI 共通でカウント。
 */
const OCR_THROTTLE_MS = 2000;
const lastOcrTriggerAt = new Map<string, number>();
function takeThrottleSlot(id: string): boolean {
  const now = Date.now();
  const last = lastOcrTriggerAt.get(id);
  if (last != null && now - last < OCR_THROTTLE_MS) return false;
  lastOcrTriggerAt.set(id, now);
  // 古い entry を gc (1 時間以上前)
  if (lastOcrTriggerAt.size > 200) {
    for (const [k, v] of lastOcrTriggerAt) {
      if (now - v > 3_600_000) lastOcrTriggerAt.delete(k);
    }
  }
  return true;
}

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
  doc_kind: z.enum(DOC_KINDS).optional(),
  sample_role: z.enum(SAMPLE_ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const TagListSchema = z.array(z.string().max(64)).max(64);

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
  /**
   * v19: 書類種別とサンプルラベル (spec/feature/scan-document-kinds.md)。 旧 payload (kind 無し) も通る。
   * kind_fields / sample の中身は種別ごとに形が違うので、 正規化は services/receipt-labels.ts に委ねる。
   */
  kind: z.enum(DOC_KINDS).optional(),
  kind_fields: z.unknown().optional(),
  sample: z.object({
    role: z.enum(SAMPLE_ROLES),
    tags: TagListSchema.optional(),
    reason: z.string().max(MAX_SAMPLE_REASON * 2).nullable().optional(),
  }).nullable().optional(),
  content_tags: TagListSchema.optional(),
});

/** 人手上書き (PATCH /v1/receipts/:id/labels)。 少なくとも 1 項目は要る。 */
const LabelsPatchSchema = z.object({
  doc_kind: z.enum(DOC_KINDS).optional(),
  sample_role: z.enum(SAMPLE_ROLES).nullable().optional(),
  sample_tags: TagListSchema.nullable().optional(),
  sample_reason: z.string().max(MAX_SAMPLE_REASON * 2).nullable().optional(),
  content_tags: TagListSchema.nullable().optional(),
}).refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: "doc_kind / sample_role / sample_tags / sample_reason / content_tags のいずれかを指定する" },
);

export interface ReceiptsApiDeps {
  repo: ReceiptsRepo;
  storage: ReceiptStorage;
  /** OCR が disabled な環境 (key 未設定 / テスト) では undefined */
  ocr?: OcrClient;
  /** 検出 BB 学習データセット writer (未設定なら /regions は no-op success) */
  dataset?: TrainingDataset;
  /** 差分の Opus 類推器 (ANTHROPIC_API_KEY 未設定なら undefined)。差分がある時だけ呼ぶ */
  diffEvaluator?: DiffEvaluator;
  /** OCR 完了時の自動投入 + 自動突合。 未設定なら従来どおり手動投入のみ */
  intake?: ReceiptIntake;
  /** 書類種別ごとの投入先 (services/receipt-kind-destinations.ts)。 未設定なら receipt / handwritten のみ投入可 */
  destinations?: KindDestinations;
  /** claude CLI OCR の `--model`。 未設定なら CLI 既定 (上限切れに巻き込まれ得る) */
  claudeCodeModel?: string | null;
  /** 撮影時の backend detect (勝ち遺伝子で sidecar を 1 回)。 未設定なら /detect は 503 */
  detect?: ReceiptDetectService;
}

/** confirm フェーズの本物 BB 永続化リクエスト */
const RegionsSchema = z.object({
  engine: z.string().max(40),
  naturalWidth: z.number().int().positive(),
  naturalHeight: z.number().int().positive(),
  regions: z.array(z.object({
    label: z.string().max(80),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    recognizedText: z.string().max(2000).optional(),
    polygon: z.array(z.tuple([z.number(), z.number()])).optional(),
    confidence: z.number().optional(),
    source: z.enum(["real", "heuristic"]).optional(),
  })).max(200),
});

export function receiptsRouter(deps: ReceiptsApiDeps): Hono {
  const app = new Hono();

  /** claude CLI OCR の起動条件は 3 経路 (自動 spawn / 手動 spawn / ログ参照) で同じにする。 */
  const newClaudeCodeOcr = (): ClaudeCodeOcr => new ClaudeCodeOcr({
    backendBaseUrl: `http://127.0.0.1:${process.env.QUAESTOR_PORT ?? 17400}`,
    workingDir: projectRoot(),
    model: deps.claudeCodeModel,
  });

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

    // stable capture (確定スキャン) と manual (手動シャッター) は自動で Claude Code OCR を spawn する。
    // speculative は spawn しない (頻度多くて claude 起動が間に合わないため、 queue 経由で手動)。
    // 2 秒 throttle が走っていれば skip (連続スキャンや手動 OCR との被りを防ぐ)
    const kind = (meta as { kind?: string }).kind;
    const autoOcr = kind === "stable" || kind === "manual";
    let autoTriggered = false;
    if (autoOcr && !deps.ocr && detectClaudeCli() && takeThrottleSlot(id)) {
      const cco = newClaudeCodeOcr();
      cco.triggerAsync(id, (ev) => {
        const cur = deps.repo.find(id);
        if (cur && cur.ocr_status === "processing") {
          deps.repo.setOcrResult(id, {
            ocr_status: "failed",
            ocr_raw: JSON.stringify({
              claude_exit: { code: ev.code, signal: ev.signal, durationMs: ev.durationMs },
              log_tail: ev.tail.slice(-2000),
              log_file: ev.logFile,
            }),
          });
        }
      }).then((t) => {
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

  /**
   * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
   * @implements SPEC-SCAN-KIND-002 (spec/feature/scan-document-kinds.md)
   */
  // PATCH /v1/receipts/:id/ocr — OCR 結果を上書き (v0.4 で OCR worker から呼ぶ)
  //  kind / kind_fields / sample / content_tags が同じ payload に載っていれば LLM ラベルとして保存する。
  //  旧 payload (kind 無し) は従来どおりフィールドだけ更新し、 ラベルは触らない (人手上書きも残る)。
  app.patch("/:id/ocr", async (c) => {
    const id = c.req.param("id");
    const r = deps.repo.find(id);
    if (!r) return c.json({ error: "not_found" }, 404);
    if (r.committed_at != null) return c.json({ error: "receipt_committed" }, 409);
    const body = await c.req.json().catch(() => null);
    const parsed = OcrResultSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { kind, kind_fields, sample, content_tags, ...fields } = parsed.data;
    deps.repo.setOcrResult(id, fields as Parameters<typeof deps.repo.setOcrResult>[1]);

    let labels: { applied: boolean; reason?: string } | null = null;
    if (kind) {
      const normalized = normalizeLlmLabels({ kind, kind_fields, sample, content_tags });
      if (normalized) {
        const outcome = applyLlmLabels(deps.repo, id, normalized);
        labels = outcome.applied ? { applied: true } : { applied: false, reason: outcome.reason };
      }
    }

    // OCR が終わった時点で完備していれば投入まで進める (弾かれたものだけ手動へ残る)
    const intake = deps.intake?.afterOcr(id);
    return c.json({
      receipt: deps.repo.find(id),
      labels,
      auto_commit: intake?.commit
        ? (intake.commit.ok
          ? { committed: true, already: intake.commit.already }
          : { committed: false, reason: commitReasonCode(intake.commit) })
        : null,
      auto_reconciled: intake?.reconcile?.matched.length ?? 0,
    });
  });

  /** @implements SPEC-SCAN-KIND-003 (spec/feature/scan-document-kinds.md) */
  // PATCH /v1/receipts/:id/labels — 種別 / サンプルラベルの人手上書き (sample_source='manual')
  app.patch("/:id/labels", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = LabelsPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const outcome = applyManualLabels(deps.repo, id, parsed.data);
    if (!outcome.applied) {
      const status = outcome.reason === "not_found" ? 404
        : outcome.reason === "committed_kind_immutable" ? 409
        : 400;
      return c.json({ error: outcome.reason }, status);
    }
    return c.json({ ok: true, receipt: deps.repo.find(id) });
  });

  // POST /v1/receipts/:id/regions — confirm フェーズの本物 BB を学習データに保存
  //  source=real の領域のみ採用。heuristic/noise は破棄 (spec §3)。
  //  backend detect (POST /:id/detect) 由来の BB は detect 側で既に保存済なので、
  //  web は persisted な領域を送ってこない (二重記録を作らない)。
  app.post("/:id/regions", async (c) => {
    const id = c.req.param("id");
    const r = deps.repo.find(id);
    if (!r) return c.json({ error: "not_found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = RegionsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const real = parsed.data.regions.filter((rg) => (rg.source ?? "heuristic") === "real");
    const outcome = recordDetection(deps, {
      receiptId: id,
      imageRef: r.image_path ?? null,
      naturalWidth: parsed.data.naturalWidth,
      naturalHeight: parsed.data.naturalHeight,
      engine: parsed.data.engine,
      regions: real.map((rg) => ({
        label: rg.label,
        x: rg.x, y: rg.y, width: rg.width, height: rg.height,
        text: rg.recognizedText,
        polygon: rg.polygon,
        confidence: rg.confidence,
      })),
      truth: { date: r.date, payee: r.payee, total: r.total, items: r.items },
    });

    return c.json({ ok: true, saved: outcome.saved, hasDiff: outcome.hasDiff });
  });

  /**
   * POST /v1/receipts/:id/detect — 勝ち遺伝子で sidecar を 1 回だけ叩き、本物 BB と
   * 運用評価レコードを出す (spec/feature/ocr-ga-evaluation.md SPEC-OCR-GA-EVAL-006)。
   *
   *  - sidecar 不達 / タイムアウト / OCR 未完は **200 で source 無しの空結果**。理由はログに出す
   *    (呼び出し側の演出は従来の fallback に落ちる)。
   *  - 同一 receipt への並行呼び出しは service 側で 1 本に畳む。
   *  - `?force=1` で評価済 receipt を測り直す (既定はキャッシュを返し 40 秒を使い直さない)。
   *
   * @implements SPEC-OCR-GA-EVAL-006 (spec/feature/ocr-ga-evaluation.md)
   */
  app.post("/:id/detect", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    if (!deps.detect) {
      return c.json({ error: "detect_disabled", message: "OCR sidecar 検出が無効です" }, 503);
    }
    const outcome = await deps.detect.detect(id, { force: c.req.query("force") === "1" });
    return c.json(outcome);
  });

  /**
   * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
   * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
   */
  // POST /v1/receipts/:id/commit — 「投入」: 種別ゲート + データ完備チェック + (日付-場所-金額) 重複判定 → 確定
  //  422 kind_not_auto_committed : 投入先の無い種別 (other)。 種別を直してから投入する
  //  422 incomplete              : その種別の投入に要る項目が欠落 (OCR 未完 or 要編集)
  //  409 duplicate               : 既に投入済の中に同じ重複キーがある (種別ごとのキー)
  app.post("/:id/commit", (c) => {
    const id = c.req.param("id");
    const outcome = commitReceipt(deps.repo, id, { trigger: "manual", destinations: deps.destinations });

    if (!outcome.ok && outcome.reason === "not_found") return c.json({ error: "not_found" }, 404);
    if (!outcome.ok && (outcome.reason === "kind_not_auto_committed" || outcome.reason === "needs_review")) {
      return c.json({
        error: outcome.reason,
        kind: outcome.kind,
        message: kindBlockMessage(outcome.kind),
      }, 422);
    }
    if (!outcome.ok && outcome.reason === "incomplete") {
      return c.json({
        error: "incomplete",
        missing: outcome.missing,
        message: `投入に必要な項目が揃っていません: ${outcome.missing.join(" / ")}`,
      }, 422);
    }
    if (!outcome.ok) {
      const r = outcome.receipt;
      return c.json({
        error: "duplicate",
        existing_id: outcome.existingId,
        message: `同じ書類が投入済: ${r.date} / ${r.payee} / ¥${r.total}`,
      }, 409);
    }

    // 投入済になった時点で取引と突き合わせる (取引が先に入っていた場合はここで成立)
    const reconciled = outcome.already ? 0 : (deps.intake?.afterCommit(id)?.matched.length ?? 0);
    return outcome.already
      ? c.json({ ok: true, already: true, receipt: outcome.receipt })
      : c.json({ ok: true, receipt: outcome.receipt, auto_reconciled: reconciled, delivery: outcome.delivery ?? null });
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
    if (!takeThrottleSlot(id)) {
      return c.json({ ok: true, throttled: true, message: "2 秒内に既に起動済 — skip" }, 200);
    }
    const result = await runOcrFor(id, { receipts: deps.repo, storage: deps.storage, client: deps.ocr });
    lastOcrTriggerAt.set(id, Date.now());
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
    if (!takeThrottleSlot(id)) {
      return c.json({ ok: true, throttled: true, message: "2 秒内に既に起動済 — skip" }, 200);
    }

    // status=processing に遷移
    deps.repo.setOcrResult(id, { ocr_status: "processing" });

    const ocr = newClaudeCodeOcr();
    const triggered = await ocr.triggerAsync(id, (ev) => {
      // claude exit 時の自動 fail-safe: PATCH しないまま終了 (= 依然 processing) なら failed に
      const cur = deps.repo.find(id);
      if (cur && cur.ocr_status === "processing") {
        deps.repo.setOcrResult(id, {
          ocr_status: "failed",
          ocr_raw: JSON.stringify({
            claude_exit: { code: ev.code, signal: ev.signal, durationMs: ev.durationMs },
            log_tail: ev.tail.slice(-2000),
            log_file: ev.logFile,
          }),
        });
      }
    });
    if (!triggered.ok) {
      deps.repo.setOcrResult(id, {
        ocr_status: "failed",
        ocr_raw: JSON.stringify({ spawn_error: triggered.error, log_file: triggered.logFile }),
      });
      return c.json({ ok: false, error: triggered.error ?? "spawn failed", log_file: triggered.logFile }, 500);
    }

    return c.json({
      ok: true,
      status: "processing",
      pid: triggered.pid,
      log_file: triggered.logFile,
      message: "claude CLI で解析中、 完了後に PATCH で結果書き戻し",
    }, 202);
  });

  // GET /v1/receipts/:id/claude-code-log — debug 用に log file の内容を返す
  app.get("/:id/claude-code-log", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const path = newClaudeCodeOcr().logPath(id);
    try {
      if (!existsSync(path)) return c.json({ log: "(no log yet)", path });
      const buf = readFileSync(path, "utf8");
      // 最大 64KB に制限
      const trimmed = buf.length > 65536 ? "...(head truncated)..." + buf.slice(-65536) : buf;
      return c.json({ log: trimmed, path, size: buf.length });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e), path }, 500);
    }
  });

  return app;
}
