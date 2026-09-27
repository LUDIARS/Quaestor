import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { gmailOAuthRouter } from "../src/api/gmail-oauth.js";
import { GmailOAuth, GMAIL_READ_SCOPE } from "../src/services/gmail-oauth.js";

const origin = "http://127.0.0.1:17400";
function fixture(allow = true) {
  const oauth = new GmailOAuth({ loadStrict: () => ({}), setMany: () => { throw new Error("not expected"); } }, origin);
  return new Hono().route("/v1/gmail-auth", gmailOAuthRouter(oauth, () => allow));
}

describe("Gmail setup HTTP boundary", () => {
  it("completes the public HTTPS flow through a TLS-terminating proxy", async () => {
    const publicOrigin = "https://qs.example.com";
    const backendOrigin = "http://qs.example.com";
    const save = vi.fn();
    const exchange = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: "access-fixture", refresh_token: "refresh-fixture", scope: GMAIL_READ_SCOPE,
    })));
    const oauth = new GmailOAuth({ loadStrict: () => ({}), setMany: save }, publicOrigin, {}, exchange);
    const app = new Hono().route("/v1/gmail-auth", gmailOAuthRouter(oauth));
    const setup = await app.request(`${backendOrigin}/v1/gmail-auth/setup`);
    expect(setup.status).toBe(200);
    expect(setup.headers.get("referrer-policy")).toBe("same-origin");
    const cookie = setup.headers.get("set-cookie")!;
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const html = await setup.text();
    expect(html).toContain(`${publicOrigin}/v1/gmail-auth/callback`);
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const start = await app.request(`${backendOrigin}/v1/gmail-auth/start`, {
      method: "POST", headers: { Origin: publicOrigin, Cookie: cookie.split(";")[0], "Sec-Fetch-Site": "same-origin" },
      body: new URLSearchParams({ csrf, client_id: "test.apps.googleusercontent.com", client_secret: "fixture" }),
    });
    expect(start.status).toBe(303);
    expect(start.headers.get("referrer-policy")).toBe("no-referrer");
    const google = new URL(start.headers.get("location")!);
    expect(google.searchParams.get("redirect_uri")).toBe(`${publicOrigin}/v1/gmail-auth/callback`);
    const callback = `${backendOrigin}/v1/gmail-auth/callback?code=fixture&state=${google.searchParams.get("state")}`;
    const complete = await app.request(callback, { headers: { Cookie: cookie.split(";")[0] } });
    expect(complete.status).toBe(303);
    expect(complete.headers.get("referrer-policy")).toBe("no-referrer");
    expect(complete.headers.get("location")).toBe(`${publicOrigin}/v1/gmail-auth/setup`);
    expect(save).toHaveBeenCalledOnce();
    expect((exchange.mock.calls[0]?.[1]?.body as URLSearchParams).get("redirect_uri"))
      .toBe(`${publicOrigin}/v1/gmail-auth/callback`);
    expect((await app.request(callback, { headers: { Cookie: cookie.split(";")[0] } })).status).toBe(400);
    expect(exchange).toHaveBeenCalledOnce();
  });
  it("rejects unconfigured hosts, forwarded-host spoofing, Viewer and cross-site public forms", async () => {
    const oauth = new GmailOAuth({ loadStrict: () => ({}), setMany: vi.fn() }, "https://qs.example.com");
    const app = new Hono().route("/v1/gmail-auth", gmailOAuthRouter(oauth));
    expect((await app.request("http://other.example/v1/gmail-auth/setup", {
      headers: { "X-Forwarded-Host": "qs.example.com", "X-Forwarded-Proto": "https" },
    })).status).toBe(403);
    expect((await app.request("http://qs.example.com/v1/gmail-auth/setup", {
      headers: { "X-Forwarded-Prefix": "/viewer/qs" },
    })).status).toBe(403);
    expect((await app.request("http://qs.example.com/v1/gmail-auth/start", {
      method: "POST", headers: { Origin: "https://attacker.example" }, body: "csrf=fixture",
    })).status).toBe(403);
  });
  it("rejects remote connections and noncanonical setup origins", async () => {
    expect((await fixture(false).request(`${origin}/v1/gmail-auth/setup`)).status).toBe(403);
    expect((await fixture().request("http://localhost:5117/v1/gmail-auth/setup")).status).toBe(403);
  });
  it("keeps the form private and rejects cross-origin submissions", async () => {
    const app = fixture();
    const response = await app.request(`${origin}/v1/gmail-auth/setup`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    const page = await response.text();
    expect(page).not.toContain("<script");
    expect(page).not.toContain("refresh_token");
    expect((await app.request(`${origin}/v1/gmail-auth/start`, {
      method: "POST", headers: { Origin: "https://attacker.example" }, body: "csrf=anything",
    })).status).toBe(403);
  });
  it("does not reflect callback secrets into error pages", async () => {
    const response = await fixture().request(`${origin}/v1/gmail-auth/callback?code=private-code&state=invalid`);
    expect(response.status).toBe(400);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).not.toContain("private-code");
  });
  it("still rejects opaque Origin even with same-origin fetch metadata", async () => {
    const response = await fixture().request(`${origin}/v1/gmail-auth/start`, {
      method: "POST", headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" }, body: "csrf=fixture",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid origin" });
  });
  it("exchanges neither codes nor tokens in status JSON", async () => {
    const response = await fixture().request(`${origin}/v1/gmail-auth/status`);
    expect(await response.json()).toEqual({ configured: false, clientConfigured: false,
      setupUrl: `${origin}/v1/gmail-auth/setup`, redirectUri: `${origin}/v1/gmail-auth/callback` });
  });
});
