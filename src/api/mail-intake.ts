import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { InboundDocumentRow, InboundDocumentsRepo } from "../db/inbound-documents-repo.js";
import type { MailMessagesRepo } from "../db/mail-messages-repo.js";
import type { MailIntakeService } from "../services/mail-intake-service.js";
import type { MailWatchRunner } from "../services/mail-watch-runner.js";
import type { ReceiptStorage } from "../services/receipt-storage.js";
import { isDirectLoopbackRequest } from "../shared/local-request.js";
import { normalizeDate } from "../shared/text.js";

const SweepSchema = z.object({ dry_run: z.boolean().optional() }).strict();
const MessageQuerySchema = z.object({
  // MailKind と同じ集合にする。 足し忘れると GET ?kind=ci_failure が 400 になる。
  kind: z.enum(["invoice", "cloud_notice", "ci_failure", "dependabot", "ignore"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const DocumentQuerySchema = z.object({
  status: z.enum(["pending", "committed", "needs_review", "ignored"]).optional(),
});
const CommitSchema = z.object({
  payee: z.string().trim().min(1).max(200),
  date: z.string().refine((value) => normalizeDate(value) === value, "invalid calendar date"),
  total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export interface MailIntakeApiDeps {
  service: MailIntakeService;
  /** realtime 未配線なら watch 系は disabled を 200 で返す */
  watch?: MailWatchRunner;
  messages: MailMessagesRepo;
  documents: InboundDocumentsRepo;
  documentsRoot: string;
  receiptStorage: ReceiptStorage;
}

/**
 * @implements SPEC-MAIL-INTAKE-003 (spec/feature/mail-intake.md)
 * @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md)
 */
export function mailIntakeRouter(deps: MailIntakeApiDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!isDirectLoopbackRequest(c) || !isTrustedBrowserContext(c.req.header("Sec-Fetch-Site"))) {
      return c.json({ error: "direct loopback access required" }, 403);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/sweep", async (c) => {
    const parsed = SweepSchema.safeParse(await c.req.json().catch(() => null));
    return parsed.success
      ? c.json(await deps.service.sweep(parsed.data))
      : c.json({ error: parsed.error.message }, 400);
  });

  /**
   * history 差分の手動同期 (デバッグ用)。 通常は Pub/Sub 通知が呼ぶ。
   * @implements SPEC-MAIL-REALTIME-001 (spec/feature/mail-realtime.md)
   */
  app.post("/sync", async (c) => c.json(await deps.service.syncFromHistory()));

  /**
   * users.watch の張り直し。 Concordia の日次 cron から叩く。
   * @implements SPEC-MAIL-REALTIME-005 (spec/feature/mail-realtime.md)
   */
  app.post("/watch/renew", async (c) => {
    if (!deps.watch) return c.json(watchUnavailable());
    return c.json(await deps.watch.renew());
  });

  /** @implements SPEC-MAIL-REALTIME-005 (spec/feature/mail-realtime.md) */
  app.post("/watch/stop", async (c) => {
    if (!deps.watch) return c.json(watchUnavailable());
    return c.json(await deps.watch.stopWatch());
  });

  /** @implements SPEC-MAIL-REALTIME-006 (spec/feature/mail-realtime.md) */
  app.get("/watch", (c) => {
    if (!deps.watch) return c.json(watchUnavailable());
    return c.json(deps.watch.status());
  });

  app.get("/messages", (c) => {
    const parsed = MessageQuerySchema.safeParse(c.req.query());
    return parsed.success
      ? c.json(deps.messages.list(parsed.data.kind, parsed.data.limit))
      : c.json({ error: parsed.error.message }, 400);
  });

  app.get("/documents", (c) => {
    const parsed = DocumentQuerySchema.safeParse(c.req.query());
    return parsed.success
      ? c.json(deps.documents.list(parsed.data.status))
      : c.json({ error: parsed.error.message }, 400);
  });

  app.get("/documents/:id/file", async (c) => {
    const document = deps.documents.find(c.req.param("id"));
    if (!document) return c.json({ error: "not found" }, 404);
    const path = resolveInboundDocumentPath(deps.documentsRoot, deps.receiptStorage, document);
    if (!path) return c.json({ error: "not found" }, 404);

    try {
      const data = await readFile(path);
      c.header("Content-Type", safeDocumentMimeType(document.mime_type));
      c.header(
        "Content-Disposition",
        `attachment; filename="invoice.pdf"; filename*=UTF-8''${encodeHeaderFilename(document.filename)}`,
      );
      return c.body(data);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.post("/documents/:id/commit", async (c) => {
    const parsed = CommitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const receiptId = await deps.service.commitDocument(c.req.param("id"), parsed.data);
    return receiptId
      ? c.json({ receipt_id: receiptId })
      : c.json({ error: "not found or not needs_review" }, 404);
  });

  app.post("/documents/:id/ignore", (c) => (
    deps.documents.ignore(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "not found or not reviewable" }, 404)
  ));

  return app;
}

/** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
export function resolveStoredDocumentPath(root: string, storedPath: string): string | null {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, storedPath);
  const pathFromRoot = relative(resolvedRoot, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    return null;
  }
  return isAbsolute(pathFromRoot) ? null : candidate;
}

/** mail 添付は inbound root、 scan 請求書は receipt storage を正本として解決する。 */
export function resolveInboundDocumentPath(
  documentsRoot: string,
  receiptStorage: Pick<ReceiptStorage, "resolve">,
  document: Pick<InboundDocumentRow, "source" | "file_path">,
): string | null {
  if (document.source === "mail") return resolveStoredDocumentPath(documentsRoot, document.file_path);
  try {
    return receiptStorage.resolve(document.file_path);
  } catch {
    return null; // ReceiptStorage が root 外の path と空 path を拒否する
  }
}

/** realtime 未配線 (設定・鍵なし) は失敗ではなく disabled として 200 で返す。 */
function watchUnavailable(): { disabled: true; reason: string } {
  return { disabled: true, reason: "mailIntake.realtime is not configured" };
}

function encodeHeaderFilename(filename: string): string {
  const safeFilename = filename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\uD800-\uDFFF]/g, "_")
    .slice(0, 180) || "invoice.pdf";
  return encodeURIComponent(safeFilename).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function safeDocumentMimeType(mimeType: string): string {
  switch (mimeType) {
    case "application/pdf":
    case "image/jpeg":
    case "image/png":
    case "image/webp":
      return mimeType;
    default:
      return "application/octet-stream";
  }
}

function isTrustedBrowserContext(fetchSite: string | undefined): boolean {
  if (!fetchSite) return true; // Non-browser loopback clients do not send Fetch Metadata headers.
  const normalized = fetchSite.toLowerCase();
  return normalized === "same-origin" || normalized === "none";
}
