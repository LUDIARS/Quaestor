import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("API: /v1/invoice-delivery-contacts", () => {
  let db: Database.Database;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    db = new Database(":memory:");
    app = buildApp({ db, receiptsRoot: "app_data/test-receipts", ocr: "disabled" });
  });

  afterEach(() => db.close());

  async function create(body: Record<string, unknown>) {
    return app.request("/v1/invoice-delivery-contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("企業名とメールアドレスを登録・一覧取得できる", async () => {
    const response = await create({ company_name: "Example Customer", email: "Billing@Example.com" });
    expect(response.status).toBe(201);
    const created = await response.json() as { contact: { id: string; company_name: string; email: string } };
    expect(created.contact).toMatchObject({ company_name: "Example Customer", email: "billing@example.com" });
    expect(created.contact.id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await app.request("/v1/invoice-delivery-contacts");
    expect(await list.json()).toMatchObject({ items: [{ company_name: "Example Customer", email: "billing@example.com" }] });
  });

  it("不正メールと未知フィールドを400、同一メールを409で拒否する", async () => {
    expect((await create({ company_name: "Example Customer", email: "not-an-email" })).status).toBe(400);
    expect((await create({ company_name: "Example Customer", email: "billing@example.com", extra: true })).status).toBe(400);
    expect((await create({ company_name: "Example Customer", email: "billing@example.com" })).status).toBe(201);
    expect((await create({ company_name: "別名", email: "BILLING@EXAMPLE.COM" })).status).toBe(409);
  });

  it("更新と無効化ができ、通常一覧から無効な送信先を除外する", async () => {
    const created = await (await create({
      company_name: "Example Customer",
      email: "billing@example.com",
    })).json() as { contact: { id: string } };
    const update = await app.request(`/v1/invoice-delivery-contacts/${created.contact.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_name: "Example Customer", email: "accounts@example.com" }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ contact: { email: "accounts@example.com" } });

    expect((await app.request(`/v1/invoice-delivery-contacts/${created.contact.id}`, { method: "DELETE" })).status)
      .toBe(200);
    expect(await (await app.request("/v1/invoice-delivery-contacts")).json()).toEqual({ items: [] });
    const all = await app.request("/v1/invoice-delivery-contacts?include_inactive=true");
    expect(await all.json()).toMatchObject({ items: [{ active: 0 }] });
  });

  it("無効化済み送信先は名称編集で復活せず、active の明示指定でのみ再有効化する", async () => {
    const created = await (await create({
      company_name: "Example Customer",
      email: "billing@example.com",
    })).json() as { contact: { id: string } };
    await app.request(`/v1/invoice-delivery-contacts/${created.contact.id}`, { method: "DELETE" });

    async function put(body: Record<string, unknown>) {
      return app.request(`/v1/invoice-delivery-contacts/${created.contact.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    const renamed = await put({ company_name: "Renamed Customer", email: "billing@example.com" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ contact: { company_name: "Renamed Customer", active: 0 } });
    expect(await (await app.request("/v1/invoice-delivery-contacts")).json()).toEqual({ items: [] });

    const reactivated = await put({
      company_name: "Renamed Customer",
      email: "billing@example.com",
      active: true,
    });
    expect(await reactivated.json()).toMatchObject({ contact: { active: 1 } });
    expect(await (await app.request("/v1/invoice-delivery-contacts")).json())
      .toMatchObject({ items: [{ company_name: "Renamed Customer" }] });
  });
});
