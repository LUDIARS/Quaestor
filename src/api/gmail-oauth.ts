import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { isDirectLoopbackRequest } from "../shared/local-request.js";
import { GmailOAuth, type GmailClient } from "../services/gmail-oauth.js";
import { gmailOAuthPage } from "../services/gmail-oauth-page.js";

const COOKIE = "qs_gmail_oauth";
const COOKIE_PATH = "/v1/gmail-auth";

export function gmailOAuthRouter(
  oauth: GmailOAuth,
  canAccess?: (context: Context) => boolean,
): Hono {
  const app = new Hono();
  const canonical = new URL(oauth.origin);
  const isPublic = canonical.protocol === "https:";
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'");
    // Cloudflare Access is the authentication boundary for the configured public host.
    // TLS terminates at the tunnel; do not derive callback URLs from forwarded headers.
    const request = new URL(c.req.url);
    const publicHost = isPublic && request.host === canonical.host && !c.req.header("X-Forwarded-Prefix");
    const permitted = canAccess ? canAccess(c) : publicHost || isDirectLoopbackRequest(c);
    if (!permitted) return c.json({ error: "Gmail setup access denied" }, 403);
    // The local status endpoint can link to the configured public setup page.
    if (c.req.path !== `${COOKIE_PATH}/status` && !(isPublic ? publicHost : request.origin === oauth.origin)) {
      return c.json({ error: "open the configured Gmail setup page" }, 403);
    }
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 65_536, onError: (c) => c.json({ error: "request too large" }, 413) }));
  app.onError((_error, c) => c.json({ error: "Gmail setup is unavailable. Reload and retry." }, 503));
  app.get("/status", (c) => c.json(oauth.status()));
  app.get("/setup", (c) => {
    // no-referrer makes a browser's form POST carry Origin:null (Fetch §3.2).
    // Preserve Origin for our same-origin form; suppress cross-origin referrers.
    // Callback and redirect responses retain the middleware's no-referrer policy.
    c.header("Referrer-Policy", "same-origin");
    const session = oauth.session(getCookie(c, COOKIE));
    setCookie(c, COOKIE, session.id, { httpOnly: true, secure: isPublic, sameSite: "Lax", path: COOKIE_PATH, maxAge: 600 });
    return c.html(gmailOAuthPage(oauth.status(), session.csrf, session.result));
  });
  app.post("/start", async (c) => {
    const origin = c.req.header("Origin");
    const site = c.req.header("Sec-Fetch-Site");
    if (origin !== oauth.origin || (site && site !== "same-origin")) return c.json({ error: "invalid origin" }, 403);
    try {
      const body = await c.req.parseBody();
      const client = await parseClient(body);
      const url = oauth.authorize(getCookie(c, COOKIE) ?? "", String(body.csrf ?? ""), client);
      // Redirects to Google are the only cross-origin form destination.
      c.header("Content-Security-Policy", "default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'");
      return c.redirect(url, 303);
    } catch {
      return c.html("<html lang=\"ja\"><meta charset=\"utf-8\"><p>クライアント情報または認証画面の期限を確認してください。</p><a href=\"/v1/gmail-auth/setup\">認証画面に戻る</a></html>", 400);
    }
  });
  app.get("/callback", async (c) => {
    try {
      await oauth.complete(getCookie(c, COOKIE) ?? "", c.req.query("state") ?? "", c.req.query("error") ? undefined : c.req.query("code"));
    } catch {
      // Invalid/expired/replayed state must never exchange a code or reveal query parameters.
      return c.html("<html lang=\"ja\"><meta charset=\"utf-8\"><p>認証の有効期限が切れたか、このブラウザで開始されていません。</p><a href=\"/v1/gmail-auth/setup\">やり直す</a></html>", 400);
    }
    return c.redirect(oauth.setupUrl, 303);
  });
  return app;
}

async function parseClient(body: Record<string, string | File | (string | File)[]>): Promise<GmailClient | undefined> {
  const file = body.client_file;
  if (file instanceof File && file.size > 0) {
    if (body.client_id || body.client_secret) throw new Error("choose one client input");
    const json: unknown = JSON.parse(await file.text());
    if (!json || typeof json !== "object") throw new Error("invalid client file");
    const root = json as Record<string, unknown>;
    const entry = root.web ?? root.installed;
    if (!entry || typeof entry !== "object") throw new Error("OAuth client required");
    const client = entry as Record<string, unknown>;
    if (typeof client.client_id !== "string" || typeof client.client_secret !== "string") throw new Error("invalid client");
    return { clientId: client.client_id, clientSecret: client.client_secret };
  }
  if (!body.client_id && !body.client_secret) return undefined;
  if (typeof body.client_id !== "string" || typeof body.client_secret !== "string") throw new Error("invalid client");
  return { clientId: body.client_id.trim(), clientSecret: body.client_secret.trim() };
}
