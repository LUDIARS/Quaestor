import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { BusinessPlansRepo } from "../src/db/business-plans-repo.js";
import { buildPlanWorkbook } from "../src/services/business-plan-export.js";
import { getTemplate } from "../src/business-plan/templates.js";
import { buildApp } from "../src/app.js";

describe("buildPlanWorkbook", () => {
  it("概要/記述/数字/検算 の4シートを生成し値が入る", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new BusinessPlansRepo(db);
    const id = repo.create({ name: "テスト計画", template: "freeform", fiscal_start: "2025-04" });
    repo.upsertSection(id, "summary", "事業の概要テキスト");
    repo.upsertFigures(id, [
      { category: "sales", label: "売上高", period: "Y1", amount: 9_000_000 },
      { category: "cogs", label: "売上原価", period: "Y1", amount: 3_000_000 },
      { category: "sga", label: "販管費", period: "Y1", amount: 4_000_000 },
    ]);
    const plan = repo.find(id)!;
    const buf = await buildPlanWorkbook(plan, repo.sections(id), repo.figures(id), getTemplate(plan.template));
    expect(buf.length).toBeGreaterThan(1000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.worksheets.map((w) => w.name).sort()).toEqual(["数字", "概要", "検算", "記述"].sort());

    // 概要に計画名
    expect(wb.getWorksheet("概要")!.getCell("B1").value).toBe("テスト計画");
    // 記述に本文
    const sc = wb.getWorksheet("記述")!;
    const bodies = sc.getColumn("B").values.map((v) => String(v ?? ""));
    expect(bodies.some((b) => b.includes("事業の概要テキスト"))).toBe(true);
    // 数字に金額
    const fg = wb.getWorksheet("数字")!;
    const nums: number[] = [];
    fg.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "number") nums.push(cell.value); }));
    expect(nums).toContain(9_000_000);
    // 検算にスコア
    expect(String(wb.getWorksheet("検算")!.getCell("B1").value)).toContain("/ 100");
  });
});

describe("API: GET /:id/export.xlsx", () => {
  it("xlsx を attachment で返す", async () => {
    const app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qbpx", ocr: "disabled", planReviewer: "disabled" });
    const create = await app.request("/v1/business-plans", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "出力テスト", template: "jfc_startup" }),
    });
    const id = (await create.json() as { plan: { id: string } }).plan.id;

    const res = await app.request(`/v1/business-plans/${id}/export.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("404: 存在しない plan の export", async () => {
    const app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qbpx2", ocr: "disabled", planReviewer: "disabled" });
    const res = await app.request("/v1/business-plans/nope/export.xlsx");
    expect(res.status).toBe(404);
  });
});
