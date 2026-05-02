import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { InvoicesRepo } from "../src/db/invoices-repo.js";
import { buildApp } from "../src/app.js";

describe("InvoicesRepo", () => {
  let db: Database.Database;
  let repo: InvoicesRepo;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new InvoicesRepo(db);
  });

  it("insert / find / list / update / delete", () => {
    const id = repo.insert({
      issued_at: "2025-04-15",
      due_date: "2025-05-15",
      client: "教育機関株式会社",
      work_summary: "4 月分授業料",
      amount: 100000,
      withholding_tax: 10210,
      status: "sent",
    });
    const found = repo.find(id);
    expect(found?.client).toBe("教育機関株式会社");
    expect(found?.amount).toBe(100000);
    expect(found?.status).toBe("sent");

    repo.update(id, { status: "paid", notes: "tx 確認済" });
    expect(repo.find(id)?.status).toBe("paid");
    expect(repo.find(id)?.notes).toBe("tx 確認済");

    expect(repo.list()).toHaveLength(1);
    expect(repo.list({ status: "paid" })).toHaveLength(1);
    expect(repo.list({ status: "sent" })).toHaveLength(0);

    repo.delete(id);
    expect(repo.list()).toHaveLength(0);
  });

  it("summary: status 別の count + amount", () => {
    repo.insert({ issued_at: "2025-04-15", client: "A", work_summary: "x", amount: 10000, status: "sent" });
    repo.insert({ issued_at: "2025-04-20", client: "B", work_summary: "y", amount: 20000, status: "paid", withholding_tax: 2000 });
    repo.insert({ issued_at: "2025-04-25", client: "C", work_summary: "z", amount: 30000, status: "paid" });

    const s = repo.summary();
    expect(s.sent.count).toBe(1);
    expect(s.sent.amount).toBe(10000);
    expect(s.paid.count).toBe(2);
    expect(s.paid.amount).toBe(50000);
    expect(s.paid.withholding).toBe(2000);
    expect(s.draft.count).toBe(0);
  });
});

describe("API: /v1/invoices + /v1/dashboard", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp({ db: new Database(":memory:"), receiptsRoot: "/tmp/qiv", ocr: "disabled" });
  });

  it("POST + GET + PATCH + DELETE", async () => {
    const create = await app.request("/v1/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        issued_at: "2025-04-15",
        client: "教育機関",
        work_summary: "4 月分",
        amount: 100000,
        withholding_tax: 10210,
      }),
    });
    expect(create.status).toBe(201);
    const j = await create.json() as { invoice: { id: number } };
    const id = j.invoice.id;

    const list = await (await app.request("/v1/invoices")).json() as { items: { id: number }[] };
    expect(list.items).toHaveLength(1);

    const patch = await app.request(`/v1/invoices/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    expect(patch.status).toBe(200);
    const pj = await patch.json() as { invoice: { status: string } };
    expect(pj.invoice.status).toBe("paid");

    const summary = await (await app.request("/v1/invoices/summary")).json() as { summary: Record<string, { count: number }> };
    expect(summary.summary.paid?.count).toBe(1);

    const del = await app.request(`/v1/invoices/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("dashboard summary: 空でも 200 を返す", async () => {
    const res = await app.request("/v1/dashboard/summary");
    expect(res.status).toBe(200);
    const j = await res.json() as { grand_total: { amount_in: number; amount_out: number; count: number } };
    expect(j.grand_total.count).toBe(0);
    expect(j.grand_total.amount_in).toBe(0);
    expect(j.grand_total.amount_out).toBe(0);
  });
});
