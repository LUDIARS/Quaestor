import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { BusinessPlansRepo } from "../src/db/business-plans-repo.js";
import { planWindows, buildVariance } from "../src/business-plan/variance.js";
import { computePlanVariance } from "../src/services/business-plan-service.js";
import type { YearPnl } from "../src/business-plan/quant.js";

describe("planWindows", () => {
  it("fiscal_start 起点で各年度のカレンダー窓を生成", () => {
    const w = planWindows("2025-04", 3);
    expect(w).toHaveLength(3);
    expect(w[0]).toMatchObject({ period: "Y1", from: "2025-04-01", to: "2026-03-31" });
    expect(w[1]).toMatchObject({ period: "Y2", from: "2026-04-01", to: "2027-03-31" });
    expect(w[2]).toMatchObject({ period: "Y3", from: "2027-04-01", to: "2028-03-31" });
  });

  it("うるう年・1月開始も正しい最終日", () => {
    const w = planWindows("2024-01", 1);
    expect(w[0]).toMatchObject({ from: "2024-01-01", to: "2024-12-31" });
  });

  it("不正な fiscal_start は空配列", () => {
    expect(planWindows("2025/04", 2)).toEqual([]);
  });
});

describe("buildVariance", () => {
  const pnl: YearPnl[] = [
    { period: "Y1", sales: 10_000_000, cogs: 4_000_000, grossProfit: 6_000_000, sga: 3_000_000, operatingProfit: 3_000_000, operatingMargin: 0.3 },
  ];
  const windows = planWindows("2025-04", 1);

  it("実績と計画の差異・達成率を計算 (elapsed)", () => {
    const rows = buildVariance(pnl, windows, { Y1: { sales: 8_000_000, expenses: 7_500_000 } }, "2026-06-01");
    expect(rows[0]!.elapsed).toBe(true);
    expect(rows[0]!.plannedSales).toBe(10_000_000);
    expect(rows[0]!.actualSales).toBe(8_000_000);
    expect(rows[0]!.salesVariance).toBe(-2_000_000);
    expect(rows[0]!.salesAchievedPct).toBeCloseTo(80, 5);
    expect(rows[0]!.plannedExpenses).toBe(7_000_000);
    expect(rows[0]!.actualProfit).toBe(500_000);
  });

  it("未到来の窓は elapsed=false", () => {
    const rows = buildVariance(pnl, windows, {}, "2025-01-01");
    expect(rows[0]!.elapsed).toBe(false);
  });
});

describe("computePlanVariance — DB 実績集計", () => {
  it("invoices(売上) と transactions(経費) を窓で集計し突合", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new BusinessPlansRepo(db);

    const id = repo.create({ name: "計画", template: "freeform", fiscal_start: "2025-04", horizon_years: 1 });
    repo.upsertFigures(id, [
      { category: "sales", label: "売上高", period: "Y1", amount: 5_000_000 },
      { category: "cogs", label: "売上原価", period: "Y1", amount: 2_000_000 },
      { category: "sga", label: "販管費", period: "Y1", amount: 1_500_000 },
    ]);

    const now = Math.floor(Date.now() / 1000);
    // 窓内 (2025-04..2026-03) の売上 invoice
    db.prepare(`INSERT INTO invoices (issued_at, client, work_summary, amount, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run("2025-06-15", "顧客A", "案件", 3_000_000, "paid", now, now);
    // 窓外 (2024) の売上は無視される
    db.prepare(`INSERT INTO invoices (issued_at, client, work_summary, amount, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run("2024-06-15", "顧客B", "案件", 9_000_000, "paid", now, now);
    // 窓内の経費 transaction (出金)
    db.prepare(`INSERT INTO transactions (id, date, amount_out, currency, description, source, is_transfer, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run("t1", "2025-07-01", 1_200_000, "JPY", "仕入", "manual", 0, now, now);
    // 振替は除外
    db.prepare(`INSERT INTO transactions (id, date, amount_out, currency, description, source, is_transfer, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run("t2", "2025-07-02", 500_000, "JPY", "口座移動", "manual", 1, now, now);

    const result = computePlanVariance(repo, db, id, "2026-06-01");
    expect(result.available).toBe(true);
    const y1 = result.rows[0]!;
    expect(y1.actualSales).toBe(3_000_000);      // 窓外 9M は除外
    expect(y1.actualExpenses).toBe(1_200_000);   // 振替 0.5M は除外
    expect(y1.salesVariance).toBe(-2_000_000);   // 3M - 5M
    expect(y1.actualProfit).toBe(1_800_000);
  });

  it("fiscal_start 未設定なら available=false", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new BusinessPlansRepo(db);
    const id = repo.create({ name: "計画", template: "freeform" });
    const result = computePlanVariance(repo, db, id, "2026-06-01");
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
