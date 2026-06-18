import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { applyMigrations } from "../src/db/schema.js";
import { WebhookDiscordNotifier, type DiscordMessage, type DiscordNotifier } from "../src/services/discord-notifier.js";
import { buildSubsidyAdvice, buildInvestAdvice, buildDividendAdvice } from "../src/services/advice-notifications.js";
import { NotificationState } from "../src/services/notification-state.js";
import { NotificationService } from "../src/services/notification-service.js";
import { NotificationWorker } from "../src/services/notification-worker.js";
import { buildApp } from "../src/app.js";
import type { Suggestion } from "../src/services/invest-advisor.js";
import type { DividendCandidateRow } from "../src/db/dividend-candidates-repo.js";
import type { SubsidySuggestion } from "../src/services/subsidy-advisor.js";

let counter = 0;
const tmpState = () => join(tmpdir(), `quaestor-notify-${process.pid}-${++counter}.json`);

function fakeNotifier(): DiscordNotifier & { sent: DiscordMessage[] } {
  const sent: DiscordMessage[] = [];
  return { enabled: true, sent, async send(m) { sent.push(m); return true; } };
}

const investSug = (ticker: string): Suggestion => ({
  payees: ["スーパーA"], visits: 12, total_spend: 48000, ticker, company_name: "会社A", market: "東証P",
  relation: "operator", confidence: 0.9, close: 2500, change_pct: 3.2, period_days: 30, as_of: "2026-06-01",
  has_perk: true, min_shares: 100, perk_description: "優待券2000円", ex_rights_months: [3, 9],
  perk_value_yen: 2000, perk_yield_pct: 0.8, required_investment: 250000,
});
const divRow = (ticker: string, y: number): DividendCandidateRow => ({
  id: 1, ticker, dividend_yield_pct: y, dps_annual: 80, payout_ratio_pct: 35, consecutive_increase_years: 10,
  ex_rights_months: "[3,9]", stability_note: null, rationale: "連続増配", source: "claude", fetched_at: 0, updated_at: 0,
});
const subSug = (id: string, fit: "high" | "low"): SubsidySuggestion => ({
  candidate: { external_id: id, name: `補助金${id}`, agency: null, kind: "subsidy", url: `https://x/${id}`,
    summary: null, target: null, requirements: null, max_amount: 2_000_000, subsidy_rate: 0.67, deadline: "2026-12-25", status: "open" },
  fit, reasoning: "要件合致", already_saved: false,
});

describe("WebhookDiscordNotifier", () => {
  it("URL 未設定なら enabled=false で送らない", async () => {
    const n = new WebhookDiscordNotifier({ webhookUrl: undefined });
    expect(n.enabled).toBe(false);
    expect(await n.send({ content: "x" })).toBe(false);
  });
  it("URL ありは webhook へ POST する", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => { body = String(init.body); return { ok: true } as Response; }) as unknown as typeof fetch;
    const n = new WebhookDiscordNotifier({ webhookUrl: "https://discord/webhook", fetchImpl });
    expect(n.enabled).toBe(true);
    expect(await n.send({ content: "hi" })).toBe(true);
    expect(body).toContain("hi");
  });
});

describe("advice builders", () => {
  it("補助金: high/medium のみ embed 化、 0件は hasContent=false", () => {
    const a = buildSubsidyAdvice("カフェ計画", [subSug("A", "high"), subSug("B", "low")]);
    expect(a.hasContent).toBe(true);
    expect(a.message.embeds![0]!.fields!.length).toBe(1);
    expect(a.message.embeds![0]!.title).toContain("カフェ計画");
    expect(buildSubsidyAdvice("x", [subSug("B", "low")]).hasContent).toBe(false);
  });
  it("投資/配当: 上位を embed 化、 dedupKey が内容で変わる", () => {
    const i1 = buildInvestAdvice([investSug("1111")]);
    const i2 = buildInvestAdvice([investSug("2222")]);
    expect(i1.hasContent).toBe(true);
    expect(i1.dedupKey).not.toBe(i2.dedupKey);
    expect(buildDividendAdvice([divRow("3333", 4.5)]).message.embeds![0]!.title).toContain("配当");
    expect(buildDividendAdvice([]).hasContent).toBe(false);
  });
});

describe("NotificationService — dedup", () => {
  function make(notifier: DiscordNotifier, statePath: string) {
    return new NotificationService({
      notifier, state: new NotificationState(statePath),
      investSuggestions: () => [investSug("1111")],
      dividendCandidates: () => [divRow("3333", 4.5)],
      subsidySuggest: async () => ({ planName: "P", suggestions: [subSug("A", "high")] }),
    });
  }

  it("オンデマンド (force) は毎回送る", async () => {
    const sp = tmpState(); const n = fakeNotifier();
    const svc = make(n, sp);
    await svc.notifyInvest();
    await svc.notifyInvest();
    expect(n.sent.length).toBe(2);
    rmSync(sp, { force: true });
  });

  it("dedup は前回と同内容なら skip、 変われば送る", async () => {
    const sp = tmpState(); const n = fakeNotifier();
    const state = new NotificationState(sp);
    const svc = new NotificationService({
      notifier: n, state,
      investSuggestions: () => [investSug("1111")],
      dividendCandidates: () => [],
      subsidySuggest: async () => ({ planName: "P", suggestions: [] }),
    });
    const r1 = await svc.notifyInvest({ dedup: true });
    expect(r1.sent).toBe(true);
    const r2 = await svc.notifyInvest({ dedup: true });
    expect(r2.sent).toBe(false);
    expect(r2.skipped).toBe(true);
    expect(n.sent.length).toBe(1);
    rmSync(sp, { force: true });
  });

  it("webhook 無効なら disabled", async () => {
    const sp = tmpState();
    const off: DiscordNotifier = { enabled: false, async send() { return false; } };
    const svc = make(off, sp);
    const r = await svc.notifyInvest();
    expect(r.disabled).toBe(true);
    rmSync(sp, { force: true });
  });

  it("通知対象が空なら skip", async () => {
    const sp = tmpState(); const n = fakeNotifier();
    const svc = new NotificationService({
      notifier: n, state: new NotificationState(sp),
      investSuggestions: () => [], dividendCandidates: () => [],
      subsidySuggest: async () => ({ planName: "P", suggestions: [] }),
    });
    expect((await svc.notifyInvest()).skipped).toBe(true);
    expect(n.sent.length).toBe(0);
    rmSync(sp, { force: true });
  });
});

describe("NotificationWorker", () => {
  it("有効なアドバイザーのエンドポイントを dedup 付きで叩く", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return { ok: true, json: async () => ({ sent: true }) } as Response;
    }) as unknown as typeof fetch;
    const w = new NotificationWorker({
      baseUrl: "http://127.0.0.1:17400", intervalMs: 999999,
      invest: true, portfolio: true, subsidies: { enabled: true, planId: "plan-1" }, fetchImpl,
    });
    await w.tick();
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:17400/v1/notify/invest",
      "http://127.0.0.1:17400/v1/notify/portfolio",
      "http://127.0.0.1:17400/v1/notify/subsidies",
    ]);
    expect(calls[0]!.body).toContain("\"dedup\":true");
    expect(calls[2]!.body).toContain("plan-1");
  });

  it("無効なアドバイザーは叩かない", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(String(url)); return { ok: true, json: async () => ({}) } as Response; }) as unknown as typeof fetch;
    const w = new NotificationWorker({ baseUrl: "http://x", intervalMs: 1, invest: false, portfolio: true, subsidies: { enabled: false, planId: null }, fetchImpl });
    await w.tick();
    expect(calls).toEqual(["http://x/v1/notify/portfolio"]);
  });
});

describe("API: /v1/notify", () => {
  it("invest 通知 (fake notifier 注入)", async () => {
    const sp = tmpState();
    const n = fakeNotifier();
    const db = new Database(":memory:");
    applyMigrations(db);
    const app = buildApp({ db, receiptsRoot: "/tmp/qn", ocr: "disabled", discordNotifier: n, notifyStatePath: sp });
    // 投資 suggestion は DB キャッシュ依存で空 → skipped になるはず (webhook は enabled)
    const res = await app.request("/v1/notify/invest", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const j = await res.json() as { disabled?: boolean; skipped?: boolean };
    expect(j.disabled).toBeUndefined(); // notifier は有効
    rmSync(sp, { force: true });
  });

  it("subsidies 通知: 存在しない plan は 404", async () => {
    const sp = tmpState();
    const app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qn2", ocr: "disabled", discordNotifier: fakeNotifier(), notifyStatePath: sp });
    const res = await app.request("/v1/notify/subsidies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan_id: "nope" }) });
    expect(res.status).toBe(404);
    rmSync(sp, { force: true });
  });
});
