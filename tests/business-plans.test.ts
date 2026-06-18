import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { BusinessPlansRepo } from "../src/db/business-plans-repo.js";
import { FinancialStatementsRepo } from "../src/db/financial-statements-repo.js";
import { buildApp } from "../src/app.js";
import { seedFromActuals, runReview } from "../src/services/business-plan-service.js";
import type { PlanReviewer } from "../src/services/plan-reviewer.js";

const fakeReviewer: PlanReviewer & { modelName: string } = {
  modelName: "fake-model",
  async review() {
    return {
      score: 70,
      summary: "総じて妥当だが市場分析が薄い。",
      findings: [
        { severity: "warning", area: "市場", code: "qualitative", message: "競合分析が不足", suggestion: "競合3社を比較" },
      ],
    };
  },
};

describe("BusinessPlansRepo — 作成時に template から seed", () => {
  let db: Database.Database;
  let repo: BusinessPlansRepo;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new BusinessPlansRepo(db);
  });

  it("jfc_startup を作ると sections と figures が seed される", () => {
    const id = repo.create({ name: "創業計画", template: "jfc_startup" });
    const sections = repo.sections(id);
    const figures = repo.figures(id);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.some((s) => s.key === "motive")).toBe(true);
    // sales は years (horizon=2) なので Y1, Y2
    const salesPeriods = figures.filter((f) => f.category === "sales").map((f) => f.period).sort();
    expect(salesPeriods).toEqual(["Y1", "Y2"]);
    // 自己資金 figure に tag が入る
    const own = figures.find((f) => f.label === "自己資金");
    expect(own?.metadata).toContain("own_funds");
  });

  it("section / figure を upsert できる", () => {
    const id = repo.create({ name: "計画", template: "freeform" });
    repo.upsertSection(id, "summary", "本文テスト");
    expect(repo.sections(id).find((s) => s.key === "summary")?.body).toBe("本文テスト");

    repo.upsertFigures(id, [{ category: "sales", label: "売上高", period: "Y1", amount: 5_000_000 }]);
    const row = repo.figures(id).find((f) => f.category === "sales" && f.period === "Y1");
    expect(row?.amount).toBe(5_000_000);
  });

  it("unknown template は throw", () => {
    expect(() => repo.create({ name: "x", template: "nope" })).toThrow();
  });
});

describe("seedFromActuals — 実績 P&L を Y1 に取り込み", () => {
  it("financial_statements の売上/経費を sales/sga の Y1 に反映", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new BusinessPlansRepo(db);
    const fs = new FinancialStatementsRepo(db);
    fs.upsert({ year: 2025, section: "pl", label: "売上 (収入) 金額", amount: 8_000_000, source: "imported" });
    fs.upsert({ year: 2025, section: "pl", label: "経費合計", amount: 3_000_000, source: "imported" });

    const id = repo.create({ name: "計画", template: "freeform" });
    const result = seedFromActuals(repo, fs, id);
    expect(result.year).toBe(2025);
    const sales = repo.figures(id).find((f) => f.category === "sales" && f.period === "Y1");
    expect(sales?.amount).toBe(8_000_000);
    expect(sales?.source).toBe("from_actuals");
    const sga = repo.figures(id).find((f) => f.category === "sga" && f.period === "Y1");
    expect(sga?.amount).toBe(3_000_000);
  });
});

describe("runReview — combined は定量+定性をマージ", () => {
  it("fake reviewer で combined レビューを保存", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new BusinessPlansRepo(db);
    const id = repo.create({ name: "計画", template: "freeform" });
    repo.upsertFigures(id, [
      { category: "sales", label: "売上高", period: "Y1", amount: 1_000_000 },
      { category: "cogs", label: "売上原価", period: "Y1", amount: 1_500_000 }, // 限界利益マイナス → error
      { category: "sga", label: "販管費", period: "Y1", amount: 200_000 },
    ]);
    const result = await runReview(repo, id, "combined", fakeReviewer);
    expect(result.kind).toBe("combined");
    expect(result.model).toBe("fake-model");
    // 定量 (negative_margin) と定性 (qualitative) の両方が混ざる
    expect(result.findings.some((f) => f.code === "negative_margin")).toBe(true);
    expect(result.findings.some((f) => f.code === "qualitative")).toBe(true);
    expect(repo.latestReview(id)?.kind).toBe("combined");
  });
});

describe("API: /v1/business-plans", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qbp", ocr: "disabled", planReviewer: fakeReviewer });
  });

  it("templates / create / get / patch / sections / figures / review", async () => {
    const tpls = await (await app.request("/v1/business-plans/templates")).json() as { templates: { id: string }[] };
    expect(tpls.templates.some((t) => t.id === "jfc_startup")).toBe(true);

    const create = await app.request("/v1/business-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "創業計画", template: "jfc_startup", purpose: "funding" }),
    });
    expect(create.status).toBe(201);
    const cj = await create.json() as { plan: { id: string; sections: unknown[]; figures: unknown[] } };
    const id = cj.plan.id;
    expect(cj.plan.sections.length).toBeGreaterThan(0);

    // section 本文
    const sec = await app.request(`/v1/business-plans/${id}/sections/motive`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "20年の業界経験から創業する。" }),
    });
    expect(sec.status).toBe(200);

    // figures 入力
    const fig = await app.request(`/v1/business-plans/${id}/figures`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        figures: [
          { category: "sales", label: "売上高", period: "Y1", amount: 9_000_000 },
          { category: "cogs", label: "売上原価 (仕入高)", period: "Y1", amount: 3_000_000 },
        ],
      }),
    });
    expect(fig.status).toBe(200);

    // review (combined、 fake reviewer)
    const rev = await app.request(`/v1/business-plans/${id}/review?kind=combined`, { method: "POST" });
    expect(rev.status).toBe(200);
    const rj = await rev.json() as { result: { kind: string; score: number }; downgraded: boolean };
    expect(rj.result.kind).toBe("combined");
    expect(rj.downgraded).toBe(false);

    const reviews = await (await app.request(`/v1/business-plans/${id}/reviews`)).json() as { reviews: unknown[] };
    expect(reviews.reviews.length).toBe(1);
  });

  it("reviewer 無しで qualitative 要求すると quantitative に縮退", async () => {
    const noLlm = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qbp2", ocr: "disabled", planReviewer: "disabled" });
    const create = await noLlm.request("/v1/business-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", template: "freeform" }),
    });
    const id = (await create.json() as { plan: { id: string } }).plan.id;
    const rev = await noLlm.request(`/v1/business-plans/${id}/review?kind=qualitative`, { method: "POST" });
    const rj = await rev.json() as { result: { kind: string }; downgraded: boolean };
    expect(rj.downgraded).toBe(true);
    expect(rj.result.kind).toBe("quantitative");
  });

  it("404: 存在しない plan", async () => {
    const res = await app.request("/v1/business-plans/nonexistent");
    expect(res.status).toBe(404);
  });
});
