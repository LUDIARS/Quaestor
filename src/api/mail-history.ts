import { Hono, type Context } from "hono";
import { z } from "zod";
import type { MailMessagesRepo } from "../db/mail-messages-repo.js";
import { isDirectLoopbackRequest } from "../shared/local-request.js";

const Query = z.object({
  kind: z.enum(["invoice", "cloud_notice", "ci_failure", "dependabot", "ignore"]).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Read-only history. Public metadata access behind Cloudflare Access approved by neco. */
export function mailHistoryRouter(
  messages: MailMessagesRepo,
  configuredOrigin?: string,
  isLocal: (c: Context) => boolean = isDirectLoopbackRequest,
): Hono {
  const app = new Hono();
  const canonical = configuredOrigin ? new URL(configuredOrigin) : undefined;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    const origin = c.req.header("Origin");
    const site = c.req.header("Sec-Fetch-Site");
    // Cloudflare Access authenticates users before forwarding to this configured host.
    // Do not derive the trusted host from client-controlled forwarding headers.
    const publicHost = canonical?.protocol === "https:"
      && new URL(c.req.url).host === canonical.host && (!origin || origin === canonical.origin);
    if (c.req.header("X-Forwarded-Prefix") || (site && site !== "same-origin" && site !== "none")
      || (!publicHost && !isLocal(c))) return c.json({ error: "mail history access denied" }, 403);
    await next();
  });
  app.get("/", (c) => {
    const query = Query.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "invalid history query" }, 400);
    const rows = messages.list(query.data.kind, 51, query.data.offset);
    return c.json({ items: rows.slice(0, 50), hasMore: rows.length > 50 });
  });
  return app;
}
