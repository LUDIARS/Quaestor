import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SubsidiesRepo } from "../src/db/subsidies-repo.js";
import { BusinessPlansRepo } from "../src/db/business-plans-repo.js";
import { JGrantsCrawler, normalize, parseRate, type SubsidyCrawler } from "../src/services/subsidy-crawler.js";
import { suggestSubsidies } from "../src/services/subsidy-advisor.js";
import type { SubsidyMatcher } from "../src/services/subsidy-matcher.js";
import { buildApp } from "../src/app.js";

const LIST = {
  result: [
    { id: "A1", name: "S-001", title: "創業支援補助金", subsidy_max_limit: 2_000_000, target_area_search: "東京都", target_number_of_employees: "20名以下", acceptance_end_datetime: "2026-12-25T02:00:00.000Z", institution_name: "東京都" },
    { id: "A2", name: "S-002", title: "販路開拓助成金", subsidy_max_limit: 0, target_area_search: "全国", target_number_of_employees: "従業員数の制約なし", acceptance_end_datetime: "2027-01-31T08:00:00.000Z", institution_name: null },
  ],
};
const DETAIL: Record<string, unknown> = {
  A1: { result: [{ id: "A1", subsidy_rate: "経費の2/3以内", detail: "創業5年以内の事業者が対象。販路開拓に使える。", subsidy_catch_phrase: "創業を応援", use_purpose: "創業したい", industry: "サービス業", front_subsidy_detail_page_url: "https://x/A1" }] },
  A2: { result: [{ id: "A2", subsidy_rate: "1/2", detail: "EC・広告費が対象。", subsidy_catch_phrase: null, use_purpose: "販路を広げたい", front_subsidy_detail_page_url: "https://x/A2" }] },
};

function fakeFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/subsidies/id/")) {
      const id = decodeURIComponent(u.split("/subsidies/id/")[1]!);
      return { ok: true, json: async () => DETAIL[id] ?? { result: [] } } as Response;
    }
    return { ok: true, json: async () => LIST } as Response;
  }) as unknown as typeof fetch;
}

describe("parseRate", () => {
  it("分数・% を 0..1 に、 取れなければ null", () => {
    expect(parseRate("経費の2/3以内")).toBeCloseTo(0.667, 3);
    expect(parseRate("1/2")).toBe(0.5);
    expect(parseRate("50%")).toBe(0.5);
    expect(parseRate("定額")).toBeNull();
    expect(parseRate(null)).toBeNull();
  });
});

const detailOf = (id: string) => (DETAIL[id] as { result: unknown[] }).result[0] as never;

describe("normalize", () => {
  it("一覧+詳細を subsidy 形式へ正規化", () => {
    const c = normalize(LIST.result[0] as never, detailOf("A1"));
    expect(c.name).toBe("創業支援補助金");
    expect(c.max_amount).toBe(2_000_000);
    expect(c.subsidy_rate).toBeCloseTo(0.667, 3);
    expect(c.deadline).toBe("2026-12-25");
    expect(c.kind).toBe("subsidy");
    expect((c.metadata as { jgrants_id: string }).jgrants_id).toBe("A1");
  });
  it("max_limit=0 は null、 助成金は kind=grant", () => {
    const c = normalize(LIST.result[1] as never, detailOf("A2"));
    expect(c.max_amount).toBeNull();
    expect(c.kind).toBe("grant");
  });
});

describe("JGrantsCrawler.search (fake fetch)", () => {
  it("一覧→詳細 enrich して候補を返す", async () => {
    const crawler = new JGrantsCrawler({ fetchImpl: fakeFetch() });
    const out = await crawler.search("創業", { limit: 5 });
    expect(out).toHaveLength(2);
    expect(out[0]!.external_id).toBe("A1");
    expect(out[0]!.requirements).toContain("創業5年以内");
  });
  it("2文字未満は空", async () => {
    const crawler = new JGrantsCrawler({ fetchImpl: fakeFetch() });
    expect(await crawler.search("創")).toEqual([]);
  });
});

const fakeCrawler: SubsidyCrawler = {
  search: async () => LIST.result.map((item) => normalize(item as never, detailOf(item.id))),
};
const fakeMatcher: SubsidyMatcher = {
  async match(input) {
    return input.subsidies.map((s, i) => ({ subsidy_id: s.id, fit: i === 0 ? "high" : "low", reasoning: `判定:${s.name}` }));
  },
};

describe("suggestSubsidies", () => {
  it("キーワード指定 → クロール → マッチングして fit 順に提案", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const plans = new BusinessPlansRepo(db);
    const repo = new SubsidiesRepo(db);
    const planId = plans.create({ name: "計画", template: "jfc_startup" });

    const { keywords, suggestions } = await suggestSubsidies(
      { plans, repo, crawler: fakeCrawler, matcher: fakeMatcher, deriveKeywords: async () => ["創業"] },
      planId,
      ["創業"],
    );
    expect(keywords).toEqual(["創業"]);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]!.fit).toBe("high");
    expect(suggestions[0]!.already_saved).toBe(false);
  });

  it("取込済みは already_saved=true", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const plans = new BusinessPlansRepo(db);
    const repo = new SubsidiesRepo(db);
    repo.insert({ name: "創業支援補助金", metadata: { jgrants_id: "A1" } });
    const planId = plans.create({ name: "計画", template: "freeform" });

    const { suggestions } = await suggestSubsidies(
      { plans, repo, crawler: fakeCrawler, matcher: fakeMatcher },
      planId,
      ["創業"],
    );
    const a1 = suggestions.find((s) => s.candidate.external_id === "A1");
    expect(a1?.already_saved).toBe(true);
  });
});

describe("API: crawl / import / suggest", () => {
  function app() {
    return buildApp({
      db: new Database(":memory:"), receiptsRoot: "/tmp/qsc", ocr: "disabled",
      subsidyMatcher: fakeMatcher, subsidyCrawler: fakeCrawler,
    });
  }

  it("crawl → import (dedup) → list", async () => {
    const a = app();
    const crawl = await a.request("/v1/subsidies/crawl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: "創業" }) });
    expect(crawl.status).toBe(200);
    const cj = await crawl.json() as { candidates: { external_id: string; name: string; already_saved: boolean }[] };
    expect(cj.candidates.length).toBe(2);
    expect(cj.candidates[0]!.already_saved).toBe(false);

    const imp = await a.request("/v1/subsidies/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidates: cj.candidates }) });
    const ij = await imp.json() as { imported: number; skipped: number };
    expect(ij.imported).toBe(2);

    // 2回目は dedup で skip
    const imp2 = await a.request("/v1/subsidies/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidates: cj.candidates }) });
    expect((await imp2.json() as { skipped: number }).skipped).toBe(2);

    const list = await (await a.request("/v1/subsidies")).json() as { items: unknown[] };
    expect(list.items).toHaveLength(2);
  });

  it("suggest: plan から提案", async () => {
    const a = app();
    const planRes = await a.request("/v1/business-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "計画", template: "jizokuka" }) });
    const planId = (await planRes.json() as { plan: { id: string } }).plan.id;
    const res = await a.request("/v1/subsidies/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan_id: planId, keywords: ["創業"] }) });
    expect(res.status).toBe(200);
    const j = await res.json() as { suggestions: { fit: string }[] };
    expect(j.suggestions.length).toBe(2);
    expect(j.suggestions[0]!.fit).toBe("high");
  });

  it("crawler 無効なら disabled", async () => {
    const a = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qsc2", ocr: "disabled", subsidyCrawler: "disabled" });
    const res = await a.request("/v1/subsidies/crawl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: "創業" }) });
    expect((await res.json() as { disabled: boolean }).disabled).toBe(true);
  });
});
