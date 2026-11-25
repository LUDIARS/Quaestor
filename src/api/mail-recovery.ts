import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { isDirectLoopbackRequest } from "../shared/local-request.js";
import type { GmailOAuth } from "../services/gmail-oauth.js";
import type { MailRecoveryService } from "../services/mail-recovery-service.js";
import { WINDOW_END, WINDOW_START } from "../services/mail-recovery-window.js";
import { GMAIL_SETUP_COOKIE } from "./gmail-oauth.js";
import { GmailRateLimit } from "../services/gmail-rate-limit.js";

const requestId = z.string().uuid();
function fixedInstant(expected: string) {
  return z.string().datetime({ offset: true }).refine(value =>
    !/\.\d{4}/.test(value) && Date.parse(value) === Date.parse(expected)).transform(() => expected);
}
const window = { startUtc: fixedInstant(WINDOW_START), endUtc: fixedInstant(WINDOW_END), request_id: requestId };
const request = z.discriminatedUnion("mode", [
  z.object({ ...window, mode: z.literal("dry_run") }).strict(),
  z.object({ ...window, mode: z.literal("import_missing"), dry_run_id: requestId }).strict(),
]);

/** Part of the existing Gmail operator cookie path. Only direct backend clients can run it. */
export function mailRecoveryRouter(oauth: GmailOAuth, recovery: MailRecoveryService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const site = c.req.header("Sec-Fetch-Site");
    if (!isDirectLoopbackRequest(c) || (site && site !== "same-origin" && site !== "none")
      || ["Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "CF-Connecting-IP"]
        .some((header) => c.req.raw.headers.has(header))
      || !oauth.hasSession(getCookie(c, GMAIL_SETUP_COOKIE), c.req.header("X-Qs-Csrf"))) {
      return c.json({ error: "operator_session_required" }, 403);
    }
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 2048 }));
  app.post("/", async (c) => {
    const body = request.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_recovery_request" }, 400);
    try {
      const job = recovery.start(body.data);
      return c.json(job, job.phase === "scanning" || job.phase === "importing" ? 202 : 200);
    } catch (error) {
      if (error instanceof GmailRateLimit) return c.json({ error: "gmail_cooldown", retryAt: error.retryAt }, 429);
      const reason = error instanceof Error ? error.message : "";
      if (["completed_dry_run_required", "request_conflict", "recovery_busy"].includes(reason)) {
        return c.json({ error: reason }, 409);
      }
      return c.json({ error: "recovery_unavailable" }, 503);
    }
  });
  app.get("/:id", (c) => {
    const id = requestId.safeParse(c.req.param("id"));
    const job = id.success && recovery.status(id.data);
    return job ? c.json(job) : c.json({ error: "unknown_request" }, 404);
  });
  return app;
}
