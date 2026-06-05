import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { applyMigrations } from "../src/db/schema.js";
import { computePerkYield } from "../src/services/invest-advisor.js";
import { normalizeResult } from "../src/services/security-mapper.js";
import { normalizePerk } from "../src/services/perk-client.js";
import type { SecurityMapper, SecurityMapResult } from "../src/services/security-mapper.js";
import type { PerkClient, PerkResult } from "../src/services/perk-client.js";
import type { StockClient, PriceHistory } from "../src/services/stock-client.js";

// ── fakes ──

class FakeMapper implements SecurityMapper {
  async map(payee: string): Promise<SecurityMapResult> {
    if (payee.includes("イオン")) {
      return { is_listed: true, ticker: "8267", company_name: "イオン", market: "東証プライム", relation: "operator", confidence: 0.95, reason: "イオンの運営" };
    }
    return { is_listed: false, ticker: null, company_name: null, market: null, relation: "none", confidence: 0.2, reason: "非上場と判断" };
  }
}

class FakeStock implements StockClient {
  async history(ticker: string): Promise<PriceHistory | null> {
    if (ticker !== "8267") return null;
    return {
      ticker, as_of: "2025-04-30",
      bars: [
        { date: "2025-04-01", close: 3000 },
        { date: "2025-04-30", close: 3300 },
      ],
    };
  }
}

class FakePerk implements PerkClient {
  async fetch(ticker: string): Promise<PerkResult> {
    if (ticker !== "8267") return { has_perk: false, min_shares: null, description: null, ex_rights_months: [], perk_value_yen: null, notes: null };
    return { has_perk: true, min_shares: 100, description: "オーナーズカード (3% キャッシュバック)", ex_rights_months: [2, 8], perk_value_yen: 3000, notes: "最新は IR 要確認" };
  }
}

function seedTx(txs: TransactionsRepo, date: string, payee: string, amount: number, n: number) {
  txs.insertOne({
    date, amount_in: null, amount_out: amount,
    currency: "JPY", fx_amount: null, fx_currency: null,
    description: payee, payee, source: "credit-card",
    source_id: `${date}|${amount}|${n}`, account: "UFJクレカ", metadata: {},
  });
}

describe("computePerkYield", () => {
  it("perk_value / (close*min_shares) * 100", () => {
    expect(computePerkYield(3000, 100, 3300)).toBe(0.91);   // 3000/330000 ≈ 0.909%
    expect(computePerkYield(null, 100, 3300)).toBeNull();
    expect(computePerkYield(3000, null, 3300)).toBeNull();
    expect(computePerkYield(3000, 100, null)).toBeNull();
  });
});

describe("normalizeResult (mapper)", () => {
  it("rejects non-4-digit ticker and forces none when not listed", () => {
    expect(normalizeResult({ is_listed: true, ticker: "abc", relation: "operator", confidence: 0.9 }).ticker).toBeNull();
    const r = normalizeResult({ is_listed: false, ticker: "8267", relation: "operator", confidence: 0.5 });
    expect(r.is_listed).toBe(false);
    expect(r.ticker).toBeNull();
    expect(r.relation).toBe("none");
  });
});

describe("normalizePerk", () => {
  it("filters month range and rounds", () => {
    const r = normalizePerk({ has_perk: true, min_shares: 100.4, ex_rights_months: [2, 13, 8, 0], perk_value_yen: 2500.6 });
    expect(r.min_shares).toBe(100);
    expect(r.ex_rights_months).toEqual([2, 8]);
    expect(r.perk_value_yen).toBe(2501);
  });
});

describe("API: /v1/invest full pipeline (fakes)", () => {
  let app: ReturnType<typeof buildApp>;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const txs = new TransactionsRepo(db);
    seedTx(txs, "2025-04-01", "イオン 中目黒店", 5000, 1);
    seedTx(txs, "2025-04-10", "イオンスタイル", 3000, 2);
    seedTx(txs, "2025-04-12", "個人カフェ", 800, 3);
    app = buildApp({
      db, receiptsRoot: "/tmp/qinvest", ocr: "disabled",
      securityMapper: new FakeMapper(), perkClient: new FakePerk(), stockClient: new FakeStock(),
    });
  });

  function post(path: string, body: unknown = {}) {
    return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  it("behavior → map → quotes → perks → suggestions", async () => {
    // 行動解析: イオン 2 支店 (別キー) + 個人カフェ = 3 エントリ
    const beh = await (await app.request("/v1/invest/behavior")).json() as { items: { payee_norm: string }[] };
    expect(beh.items.length).toBe(3);

    // マッピング: 3 件解析、 イオン 2 支店が共に 8267 へ → listed 2
    const map = await (await post("/v1/invest/map")).json() as { summary: { analyzed: number; listed: number } };
    expect(map.summary.analyzed).toBe(3);
    expect(map.summary.listed).toBe(2);

    // 2 回目は skip される
    const map2 = await (await post("/v1/invest/map")).json() as { summary: { analyzed: number; skipped: number } };
    expect(map2.summary.analyzed).toBe(0);
    expect(map2.summary.skipped).toBeGreaterThanOrEqual(1);

    // 株価
    const q = await (await post("/v1/invest/quotes/refresh", { period_days: 90 })).json() as { summary: { succeeded: number } };
    expect(q.summary.succeeded).toBe(1);

    // 優待
    const p = await (await post("/v1/invest/perks/refresh")).json() as { summary: { succeeded: number } };
    expect(p.summary.succeeded).toBe(1);

    // 統合提案
    const sug = await (await app.request("/v1/invest/suggestions")).json() as { items: any[] };
    expect(sug.items).toHaveLength(1);
    const s = sug.items[0];
    expect(s.ticker).toBe("8267");
    expect(s.total_spend).toBe(8000);
    expect(s.close).toBe(3300);
    expect(s.change_pct).toBe(10);
    expect(s.has_perk).toBe(true);
    expect(s.min_shares).toBe(100);
    expect(s.required_investment).toBe(330000);
    expect(s.perk_yield_pct).toBeGreaterThan(0);
    expect(s.ex_rights_months).toEqual([2, 8]);
  });

  it("manual mapping override", async () => {
    const res = await app.request("/v1/invest/map/" + encodeURIComponent("個人カフェ"), {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticker: "3387", company_name: "クリエイト・レストランツ", relation: "parent" }),
    });
    expect(res.status).toBe(200);
    const sec = await (await app.request("/v1/invest/securities")).json() as { items: { ticker: string | null }[] };
    expect(sec.items.some((i) => i.ticker === "3387")).toBe(true);
  });

  it("returns 503 when mapper disabled", async () => {
    const app2 = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qx", ocr: "disabled", securityMapper: "disabled", perkClient: "disabled", stockClient: "disabled" });
    const res = await app2.request("/v1/invest/map", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
  });
});
