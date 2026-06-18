import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SubsidiesRepo } from "../src/db/subsidies-repo.js";
import { normalizeMatches, type SubsidyMatcher } from "../src/services/subsidy-matcher.js";
import { buildApp } from "../src/app.js";

describe("SubsidiesRepo", () => {
  let db: Database.Database;
  let repo: SubsidiesRepo;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new SubsidiesRepo(db);
  });

  it("insert / find / list / update / delete", () => {
    const id = repo.insert({
      name: "小規模事業者持続化補助金", agency: "中小企業庁", kind: "subsidy",
      max_amount: 500_000, subsidy_rate: 0.67, deadline: "2026-09-30", status: "open",
      requirements: "小規模事業者\n販路開拓",
    });
    expect(repo.find(id)?.name).toBe("小規模事業者持続化補助金");
    expect(repo.find(id)?.subsidy_rate).toBeCloseTo(0.67, 5);

    repo.update(id, { status: "closed", notes: "締切済" });
    expect(repo.find(id)?.status).toBe("closed");

    expect(repo.list()).toHaveLength(1);
    expect(repo.list({ status: "open" })).toHaveLength(0);
    expect(repo.list({ status: "closed" })).toHaveLength(1);

    repo.delete(id);
    expect(repo.list()).toHaveLength(0);
  });

  it("list は status 指定で締切順", () => {
    repo.insert({ name: "A", status: "open", deadline: "2026-12-01" });
    repo.insert({ name: "B", status: "open", deadline: "2026-06-01" });
    const open = repo.list({ status: "open" });
    expect(open.map((s) => s.name)).toEqual(["B", "A"]);
  });
});

describe("normalizeMatches", () => {
  const valid = new Set([1, 2, 3]);
  it("配列を正規化し fit 高い順に並べる", () => {
    const out = normalizeMatches(
      [
        { subsidy_id: 1, fit: "low", reasoning: "対象外寄り" },
        { subsidy_id: 2, fit: "high", reasoning: "要件合致" },
      ],
      valid,
    );
    expect(out.map((m) => m.subsidy_id)).toEqual([2, 1]);
    expect(out[0]!.fit).toBe("high");
  });
  it("候補に無い id・不正値は捨てる", () => {
    const out = normalizeMatches([{ subsidy_id: 99, fit: "high" }, { subsidy_id: 1, fit: "bogus" }], valid);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subsidy_id: 1, fit: "low" });
  });
  it("{matches:[...]} ラップも受ける", () => {
    const out = normalizeMatches({ matches: [{ subsidy_id: 3, fit: "medium", reasoning: "条件次第" }] }, valid);
    expect(out[0]).toMatchObject({ subsidy_id: 3, fit: "medium" });
  });
});

const fakeMatcher: SubsidyMatcher = {
  async match(input) {
    return input.subsidies.map((s, i) => ({
      subsidy_id: s.id,
      fit: i === 0 ? "high" : "low",
      reasoning: `判定: ${s.name}`,
    }));
  },
};

describe("API: /v1/subsidies", () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qsub", ocr: "disabled", subsidyMatcher: fakeMatcher });
  });

  it("CRUD", async () => {
    const create = await app.request("/v1/subsidies", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ものづくり補助金", agency: "中小企業庁", status: "open" }),
    });
    expect(create.status).toBe(201);
    const id = (await create.json() as { subsidy: { id: number } }).subsidy.id;

    expect((await (await app.request("/v1/subsidies")).json() as { items: unknown[] }).items).toHaveLength(1);

    const patch = await app.request(`/v1/subsidies/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_amount: 10_000_000 }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json() as { subsidy: { max_amount: number } }).subsidy.max_amount).toBe(10_000_000);

    expect((await app.request(`/v1/subsidies/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("POST /match: 計画に合う補助金をランク付け", async () => {
    // 計画作成
    const planRes = await app.request("/v1/business-plans", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "計画", template: "jizokuka" }),
    });
    const planId = (await planRes.json() as { plan: { id: string } }).plan.id;
    // open な補助金2件
    await app.request("/v1/subsidies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "持続化", status: "open" }) });
    await app.request("/v1/subsidies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ものづくり", status: "open" }) });

    const res = await app.request("/v1/subsidies/match", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: planId }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { matches: { subsidy_id: number; fit: string; subsidy: { name: string } | null }[] };
    expect(j.matches).toHaveLength(2);
    expect(j.matches[0]!.fit).toBe("high");
    expect(j.matches[0]!.subsidy?.name).toBeTruthy();
  });

  it("POST /match: matcher 無効なら disabled", async () => {
    const noLlm = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qsub2", ocr: "disabled", subsidyMatcher: "disabled" });
    const planRes = await noLlm.request("/v1/business-plans", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "計画", template: "freeform" }),
    });
    const planId = (await planRes.json() as { plan: { id: string } }).plan.id;
    const res = await noLlm.request("/v1/subsidies/match", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_id: planId }),
    });
    const j = await res.json() as { disabled?: boolean };
    expect(j.disabled).toBe(true);
  });
});
