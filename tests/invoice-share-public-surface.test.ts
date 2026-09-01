import { afterEach, describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { buildApp } from "../src/app.js";

/**
 * 公開経路の面を固定する。
 *
 * 公開マジックリンクの前段 (Cloudflare) は `share/` 配下を丸ごと通す設定にしてある。
 * そのため「何を公開するか」の判断はここで担保する — 公開面が増えると、無認証で
 * 到達できる口が黙って増える。増やすときは公開してよいか判断してからこの一覧を更新する。
 */
const ALLOWED_PUBLIC_SHARE_ROUTES = [
  "GET /v1/invoices/share/passkey.js",
  "GET /v1/invoices/share/:token",
  "POST /v1/invoices/share/:token/accept",
] as const;

const openDatabases: Database.Database[] = [];

function makeApp() {
  const db = new Database(":memory:");
  openDatabases.push(db);
  applyMigrations(db);
  return buildApp({ db, ocr: "disabled", notifier: "disabled" });
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

describe("公開経路の面", () => {
  it("share 配下に公開されているのは決められた 3 本だけ", () => {
    const app = makeApp();
    const actual = app.routes
      .filter((route) => route.path.startsWith("/v1/invoices/share"))
      // ミドルウェア (ALL /v1/invoices/share/*) は面ではないので除く
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(actual).toEqual([...ALLOWED_PUBLIC_SHARE_ROUTES].sort());
  });

  it("PDF と証跡は子パスではなく view クエリで出す", async () => {
    const app = makeApp();
    // 存在しない token でも、 子パスが無いこと (404 の出どころがルート不在でないこと) を確かめる
    const document = await app.request("/v1/invoices/share/nosuch/document.pdf");
    const evidence = await app.request("/v1/invoices/share/nosuch/evidence.json");
    expect(document.status).toBe(404);
    expect(evidence.status).toBe(404);
    // view クエリ側は公開 share ハンドラに入る。本文で Hono のデフォルト 404 と区別する。
    const viaQuery = await app.request("/v1/invoices/share/nosuch?view=document");
    expect([403, 404]).toContain(viaQuery.status);
    expect(await viaQuery.text()).toContain("リンクを確認できません");
  });

  it("パスキーの各段階は accept に集約され、子パスを持たない", async () => {
    const app = makeApp();
    for (const path of ["options", "register", "accept"]) {
      const res = await app.request(`/v1/invoices/share/nosuch/passkey/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
    }
  });

  it("パスキー JSON body の UTF-8 バイト上限を超えた入力を拒否する", async () => {
    const app = makeApp();
    const res = await app.request("/v1/invoices/share/nosuch/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phase: "passkey-accept",
        challenge_id: "00000000-0000-4000-8000-000000000000",
        response: {
          id: "credential",
          rawId: "credential",
          type: "public-key",
          clientExtensionResults: {},
          response: { padding: "あ".repeat(22_000) },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});
