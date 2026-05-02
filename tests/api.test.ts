import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import iconv from "iconv-lite";
import { buildApp } from "../src/app.js";

function makeApp() {
  const db = new Database(":memory:");
  return buildApp({ db });
}

function syntheticUfjCsvB64(): string {
  const text = [
    "確定情報,カード番号,店名,ご利用日,ご利用区分,支払回数,ご利用金額,支払総額,,,,",
    "確定,1234,NOTION LABS INC.,2025/1/15,1回払い,,14679,14679,,,,",
    "確定,1234,サイゼリヤ／ＮＦＣ,2025/3/12,1回払い,,1820,1820,,,,",
  ].join("\r\n");
  return iconv.encode(text, "Shift_JIS").toString("base64");
}

describe("API", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => { app = makeApp(); });

  it("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; service: string };
    expect(j.ok).toBe(true);
    expect(j.service).toBe("quaestor");
  });

  it("POST /v1/imports inserts UFJ CSV transactions", async () => {
    const res = await app.request("/v1/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_b64: syntheticUfjCsvB64(), filename: "ufj-2025q1.csv" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { brand: string; inserted: number; duplicates: number; parsed: number };
    expect(j.brand).toBe("ufj");
    expect(j.parsed).toBe(2);
    expect(j.inserted).toBe(2);
    expect(j.duplicates).toBe(0);
  });

  it("re-importing same CSV produces 0 inserted, 2 duplicates", async () => {
    const csvB64 = syntheticUfjCsvB64();
    const post = () => app.request("/v1/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_b64: csvB64 }),
    });
    await post();
    const res2 = await post();
    const j = await res2.json() as { inserted: number; duplicates: number };
    expect(j.inserted).toBe(0);
    expect(j.duplicates).toBe(2);
  });

  it("GET /v1/transactions filters by date range and payee_like", async () => {
    await app.request("/v1/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_b64: syntheticUfjCsvB64() }),
    });

    const all = await (await app.request("/v1/transactions")).json() as { items: { payee: string }[]; total: number };
    expect(all.total).toBe(2);

    const filtered = await (
      await app.request("/v1/transactions?payee_like=NOTION")
    ).json() as { items: { payee: string }[]; total: number };
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]!.payee).toContain("NOTION");

    const dateFiltered = await (
      await app.request("/v1/transactions?date_from=2025-02-01&date_to=2025-12-31")
    ).json() as { total: number };
    expect(dateFiltered.total).toBe(1);
  });

  it("422 when no importer matches", async () => {
    const buf = Buffer.from("foo,bar,baz\r\n1,2,3\r\n", "utf8");
    const res = await app.request("/v1/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_b64: buf.toString("base64") }),
    });
    expect(res.status).toBe(422);
  });
});
