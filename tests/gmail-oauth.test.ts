import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { GMAIL_READ_SCOPE, GmailOAuth } from "../src/services/gmail-oauth.js";

const origin = "http://127.0.0.1:17400";
const client = { clientId: "test.apps.googleusercontent.com", clientSecret: "client-secret-fixture" };
function fixture(scope = GMAIL_READ_SCOPE) {
  let values: Record<string, string> = { OTHER_SECRET: "preserve" };
  let now = 1000;
  const setMany = vi.fn((entries: Record<string, string>) => { values = { ...values, ...entries }; });
  const exchange = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    access_token: "access-fixture", refresh_token: "refresh-fixture", scope,
  }), { status: 200 }));
  const oauth = new GmailOAuth({ loadStrict: () => values, setMany }, origin, {}, exchange, () => now);
  return { oauth, setMany, exchange, values: () => values, expire: () => { now += 600_001; } };
}

describe("browser-bound Gmail OAuth", () => {
  it("uses PKCE, exchanges on the server and atomically stores credentials without returning tokens", async () => {
    const f = fixture();
    const session = f.oauth.session();
    const auth = new URL(f.oauth.authorize(session.id, session.csrf, client));
    expect(auth.searchParams.get("scope")).toBe(GMAIL_READ_SCOPE);
    expect(auth.searchParams.get("access_type")).toBe("offline");
    expect(auth.searchParams.get("client_secret")).toBeNull();
    await f.oauth.complete(session.id, auth.searchParams.get("state")!, "code-fixture");
    const body = f.exchange.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"))
      .toBe(auth.searchParams.get("code_challenge"));
    expect(body.get("redirect_uri")).toBe(`${origin}/v1/gmail-auth/callback`);
    expect(f.setMany).toHaveBeenCalledTimes(1);
    expect(f.values().OTHER_SECRET).toBe("preserve");
    expect(f.oauth.status().configured).toBe(true);
    expect(JSON.stringify(f.oauth.status())).not.toContain("fixture");
    expect(f.oauth.session(session.id).result).toBe("saved");
    await expect(f.oauth.complete(session.id, auth.searchParams.get("state")!, "code-fixture")).rejects.toThrow();
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects another browser, incorrect CSRF, mismatched state and expired callbacks", async () => {
    const f = fixture();
    const a = f.oauth.session();
    const b = f.oauth.session();
    expect(() => f.oauth.authorize(a.id, b.csrf, client)).toThrow();
    const auth = new URL(f.oauth.authorize(a.id, a.csrf, client));
    const state = auth.searchParams.get("state")!;
    await expect(f.oauth.complete(b.id, state, "code")).rejects.toThrow();
    await expect(f.oauth.complete(a.id, "wrong", "code")).rejects.toThrow();
    f.expire();
    await expect(f.oauth.complete(a.id, state, "code")).rejects.toThrow();
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.setMany).not.toHaveBeenCalled();
  });

  it.each(["https://www.googleapis.com/auth/gmail.send", ""])("does not save missing read scope: %s", async (scope) => {
    const f = fixture(scope);
    const session = f.oauth.session();
    const url = new URL(f.oauth.authorize(session.id, session.csrf, client));
    await f.oauth.complete(session.id, url.searchParams.get("state")!, "code");
    expect(f.setMany).not.toHaveBeenCalled();
    expect(f.oauth.session(session.id).result).toBe("failed");
  });

  it("cancellation consumes the pending state without a token exchange", async () => {
    const f = fixture();
    const session = f.oauth.session();
    const url = new URL(f.oauth.authorize(session.id, session.csrf, client));
    await f.oauth.complete(session.id, url.searchParams.get("state")!, undefined);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.setMany).not.toHaveBeenCalled();
  });
});
