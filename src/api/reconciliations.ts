import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ReconciliationsRepo } from "../db/reconciliations-repo.js";
import type { ReceiptsRepo } from "../db/receipts-repo.js";
import { findCandidates, DEFAULTS } from "../services/reconcile.js";

const CreateSchema = z.object({
  receipt_id: z.string().min(1),
  transaction_id: z.string().min(1),
  matched_by: z.enum(["auto", "manual"]).default("manual"),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(500).nullable().optional(),
});

const AutoMatchSchema = z.object({
  /** auto-match の閾値。 既定 0.85 */
  threshold: z.number().min(0).max(1).optional(),
  /** 対象 receipt id 群 (省略時は OCR 完了済の全 receipt を対象) */
  receipt_ids: z.array(z.string()).optional(),
});

export interface ReconciliationsApiDeps {
  db: Database.Database;
  repo: ReconciliationsRepo;
  receipts: ReceiptsRepo;
}

export function reconciliationsRouter(deps: ReconciliationsApiDeps): Hono {
  const app = new Hono();

  // GET /v1/reconciliations
  app.get("/", (c) => c.json({ items: deps.repo.list() }));

  app.get("/by-receipt/:id", (c) => c.json({ items: deps.repo.byReceipt(c.req.param("id")) }));

  // POST /v1/reconciliations — manual 確定
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const id = deps.repo.insert(parsed.data);
    if (id == null) return c.json({ error: "duplicate" }, 409);
    return c.json({ reconciliation: deps.repo.find(id) }, 201);
  });

  // DELETE /v1/reconciliations/:id
  app.delete("/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const ok = deps.repo.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // GET /v1/receipts/:id/match-candidates — receipt の matching 候補を計算 (永続化なし)
  app.get("/match-candidates/:receiptId", (c) => {
    const r = deps.receipts.find(c.req.param("receiptId"));
    if (!r) return c.json({ error: "receipt not found" }, 404);
    const cands = findCandidates(deps.db, r);
    return c.json({
      receipt_id: r.id,
      candidates: cands.map((m) => ({
        transaction: m.transaction,
        score: m.score,
        confidence: m.score.total,
        band: bandFor(m.score.total),
      })),
    });
  });

  // POST /v1/reconciliations/auto-match — 全 (or 指定) receipt に対し閾値以上を auto 確定
  app.post("/auto-match", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = AutoMatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const threshold = parsed.data.threshold ?? 0.85;

    let receipts = parsed.data.receipt_ids
      ? parsed.data.receipt_ids
          .map((id) => deps.receipts.find(id))
          .filter((r) => r != null)
      : deps.receipts.list({ status: "done", limit: 1000 });

    // 既に reconcile 済の receipt は除外
    receipts = receipts.filter((r) => deps.repo.byReceipt(r!.id).length === 0);

    const matched: { receipt_id: string; transaction_id: string; confidence: number }[] = [];
    const skipped: { receipt_id: string; reason: string }[] = [];
    for (const r of receipts) {
      if (!r) continue;
      const cands = findCandidates(deps.db, r);
      const top = cands[0];
      if (!top) { skipped.push({ receipt_id: r.id, reason: "no candidates" }); continue; }
      if (top.score.total < threshold) {
        skipped.push({ receipt_id: r.id, reason: `top score ${top.score.total.toFixed(2)} < ${threshold}` });
        continue;
      }
      const id = deps.repo.insert({
        receipt_id: r.id,
        transaction_id: top.transaction.id,
        matched_by: "auto",
        confidence: top.score.total,
      });
      if (id != null) matched.push({ receipt_id: r.id, transaction_id: top.transaction.id, confidence: top.score.total });
      else skipped.push({ receipt_id: r.id, reason: "duplicate (race)" });
    }

    return c.json({ threshold, matched, skipped });
  });

  return app;
}

function bandFor(score: number): "auto" | "suggest" | "weak" {
  if (score >= 0.85) return "auto";
  if (score >= DEFAULTS.minScore) return "suggest";
  return "weak";
}
