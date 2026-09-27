import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { gmailOAuthRouter } from "../src/api/gmail-oauth.js";
import { GmailOAuth } from "../src/services/gmail-oauth.js";

const origin = "http://127.0.0.1:17400";
function fixture(allow = true) {
  const oauth = new GmailOAuth({ loadStrict: () => ({}), setMany: () => { throw new Error("not expected"); } }, origin);
  return new Hono().route("/v1/gmail-auth", gmailOAuthRouter(oauth, () => allow));
}

describe("Gmail setup HTTP boundary", () => {
  it("rejects remote connections and noncanonical setup origins", async () => {
    expect((await fixture(false).request(`${origin}/v1/gmail-auth/setup`)).status).toBe(403);
    expect((await fixture().request("http://localhost:5117/v1/gmail-auth/setup")).status).toBe(403);
  });
  it("keeps the form private and rejects cross-origin submissions", async () => {
    const app = fixture();
    const response = await app.request(`${origin}/v1/gmail-auth/setup`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
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
    expect(await response.text()).not.toContain("private-code");
  });
  it("exchanges neither codes nor tokens in status JSON", async () => {
    const response = await fixture().request(`${origin}/v1/gmail-auth/status`);
    expect(await response.json()).toEqual({ configured: false, clientConfigured: false,
      setupUrl: `${origin}/v1/gmail-auth/setup`, redirectUri: `${origin}/v1/gmail-auth/callback` });
  });
});
