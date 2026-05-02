import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { AccountCodesRepo } from "../src/db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { matchRule, SEED_RULES } from "../src/db/seed.js";
import { buildApp } from "../src/app.js";

describe("matchRule (pure)", () => {
  it("returns first match by priority", () => {
    const m = matchRule(SEED_RULES, "AMAZON WEB SERV");
    expect(m).toBeDefined();
    expect(m!.code).toBe(26);
    expect(m!.rate).toBe(1);
  });

  it("more specific rule wins (Netflix vs PAYPAL fallback)", () => {
    const m = matchRule(SEED_RULES, "NETFLIX.COM");
    expect(m!.rate).toBe(0.5);
    expect(m!.code).toBe(26);
  });

  it("unmatched returns null", () => {
    const m = matchRule(SEED_RULES, "RANDOM SHOP NAME 12345");
    expect(m).toBeNull();
  });
});

describe("ApportionmentRulesRepo (seed + resolve)", () => {
  let db: Database.Database;
  let accounts: AccountCodesRepo;
  let rules: ApportionmentRulesRepo;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    accounts = new AccountCodesRepo(db);
    rules = new ApportionmentRulesRepo(db);
    accounts.seedIfEmpty();
    rules.seedIfEmpty();
  });

  it("seed populates SEED_RULES + SEED_ACCOUNTS", () => {
    expect(accounts.list().length).toBeGreaterThanOrEqual(15);
    expect(rules.list().length).toBeGreaterThanOrEqual(20);
  });

  it("seedIfEmpty is idempotent", () => {
    const before = rules.list().length;
    rules.seedIfEmpty();
    rules.seedIfEmpty();
    expect(rules.list().length).toBe(before);
  });

  it("resolve(AWS) → 100% / 26", () => {
    const r = rules.resolve("ＡＭＡＺＯＮ　ＷＥＢ　ＳＥＲＶ");
    expect(r.rate).toBe(1);
    expect(r.code).toBe(26);
    expect(r.rule_id).not.toBeNull();
  });

  it("resolve(au) → 70% / 12", () => {
    const r = rules.resolve("ａｕ電話利用料");
    expect(r.rate).toBeCloseTo(0.7);
    expect(r.code).toBe(12);
  });

  it("resolve(unknown) → 0% / 124 (fallback 事業主貸)", () => {
    const r = rules.resolve("FOO BAR BAZ STORE");
    expect(r.rate).toBe(0);
    expect(r.code).toBe(124);
    expect(r.rule_id).toBeNull();
  });

  it("custom rule with high priority wins over seed", () => {
    rules.insert({
      pattern: "AMAZON",
      rate: 0.5,
      code: 25,
      priority: 0,            // 最優先
      note: "test override",
    });
    const r = rules.resolve("AMAZON WEB SERV");
    expect(r.rate).toBe(0.5);
    expect(r.code).toBe(25);
  });

  it("disabled rule is skipped", () => {
    const id = rules.insert({
      pattern: "MYSHOP",
      rate: 1.0,
      code: 26,
      priority: 5,
    });
    expect(rules.resolve("MYSHOP TEST").code).toBe(26);
    rules.update(id, { enabled: false });
    expect(rules.resolve("MYSHOP TEST").code).toBe(124); // fallback
  });
});

describe("API: /v1/apportionment-rules", () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { app = buildApp({ db: new Database(":memory:") }); });

  it("GET / returns seeded rules", async () => {
    const res = await app.request("/v1/apportionment-rules");
    const j = await res.json() as { items: { id: number }[] };
    expect(j.items.length).toBeGreaterThan(20);
  });

  it("POST /resolve { payee }", async () => {
    const res = await app.request("/v1/apportionment-rules/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payee: "OPENAI ChatGPT Plus" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { rate: number; code: number };
    expect(j.rate).toBe(1);
    expect(j.code).toBe(26);
  });

  it("POST / creates a custom rule, then DELETE removes it", async () => {
    const create = await app.request("/v1/apportionment-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "MYSTORE\\d+", rate: 0.5, code: 26, priority: 5, note: "test" }),
    });
    expect(create.status).toBe(201);
    const cj = await create.json() as { rule: { id: number } };
    const id = cj.rule.id;

    const resolved = await app.request("/v1/apportionment-rules/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payee: "MYSTORE42" }),
    });
    const rj = await resolved.json() as { rate: number };
    expect(rj.rate).toBe(0.5);

    const del = await app.request(`/v1/apportionment-rules/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("POST / rejects invalid regex", async () => {
    const res = await app.request("/v1/apportionment-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "[unclosed", rate: 1, code: 26 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("API: /v1/account-codes", () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { app = buildApp({ db: new Database(":memory:") }); });

  it("GET / returns seeded accounts including 124 事業主貸", async () => {
    const res = await app.request("/v1/account-codes");
    const j = await res.json() as { items: { code: number; name: string }[] };
    const owner = j.items.find((a) => a.code === 124);
    expect(owner).toBeDefined();
    expect(owner!.name).toBe("事業主貸");
  });
});
