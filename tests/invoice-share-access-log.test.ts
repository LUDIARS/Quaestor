/** @implements SPEC-INVOICE-ACCESS-003 (spec/feature/invoice-public-magic-link.md) */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  invoiceShareAccessLog,
  tokenFingerprint,
  tokenFromPath,
  VERBOSE_INVOICE_SHARE,
} from "../src/api/invoice-share-access-log.js";

interface Line { fields: Record<string, unknown>; message: string }

function recorder() {
  const lines: Line[] = [];
  return {
    lines,
    logger: {
      info: (fields: Record<string, unknown>, message?: string) => lines.push({ fields, message: message ?? "" }),
      warn: (fields: Record<string, unknown>, message?: string) => lines.push({ fields, message: message ?? "" }),
    },
  };
}

function appWith(logger: Parameters<typeof invoiceShareAccessLog>[0]) {
  const app = new Hono();
  app.use("/v1/invoices/share/*", invoiceShareAccessLog(logger));
  app.get("/v1/invoices/share/:token", (c) => c.text("ok"));
  app.get("/v1/invoices/share/:token/boom", () => { throw new Error("inner failure"); });
  return app;
}

describe("invoiceShareAccessLog", () => {
  it("入口と出口をペアで記録する (出口が無ければ途中で落ちたと分かる)", async () => {
    const { lines, logger } = recorder();
    const res = await appWith(logger).request("/v1/invoices/share/abc");
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(2);
    expect(lines[0].message).toBe(`${VERBOSE_INVOICE_SHARE} request`);
    expect(lines[1].message).toBe(`${VERBOSE_INVOICE_SHARE} response`);
    expect(lines[1].fields.status).toBe(200);
    expect(typeof lines[1].fields.elapsed_ms).toBe("number");
  });

  it("token は生値を出さず、同じ token は同じ指紋になる", async () => {
    const { lines, logger } = recorder();
    await appWith(logger).request("/v1/invoices/share/secret-token-value");
    const printed = JSON.stringify(lines);
    expect(printed).not.toContain("secret-token-value");
    expect(lines[0].fields.token).toBe(tokenFingerprint("secret-token-value"));
    // パスに埋まった token も指紋へ置換されている
    expect(lines[0].fields.path).toBe(`/v1/invoices/share/<token:${tokenFingerprint("secret-token-value")}>`);
    expect(String(lines[0].fields.token)).toHaveLength(8);
  });

  it("未知の子パスも生値を出さない", async () => {
    const { lines, logger } = recorder();
    await appWith(logger).request("/v1/invoices/share/secret-token/private@example.com");
    const printed = JSON.stringify(lines);
    expect(printed).not.toContain("secret-token");
    expect(printed).not.toContain("private@example.com");
    expect(lines[0].fields.path).toMatch(/^\/v1\/invoices\/share\/<token:[0-9a-f]{8}>\/<path:[0-9a-f]{12}>$/);
  });

  it("Cloudflare 経由かどうかを記録する (届いていない切り分けの一次情報)", async () => {
    const { lines, logger } = recorder();
    const app = appWith(logger);
    await app.request("/v1/invoices/share/abc");
    expect(lines[0].fields.via_cloudflare).toBe(false);
    lines.length = 0;
    await app.request("/v1/invoices/share/abc", {
      headers: {
        "CF-Connecting-IP": "203.0.113.7",
        "User-Agent": "private-browser-details",
      },
    });
    expect(lines[0].fields.via_cloudflare).toBe(true);
    expect(String(lines[0].fields.client)).toHaveLength(12);
    expect(String(lines[0].fields.user_agent)).toHaveLength(12);
    expect(JSON.stringify(lines)).not.toContain("203.0.113.7");
    expect(JSON.stringify(lines)).not.toContain("private-browser-details");
  });

  it("下流例外の本文をログへ出さない", async () => {
    const { lines, logger } = recorder();
    const app = new Hono();
    app.use("/v1/invoices/share/*", invoiceShareAccessLog(logger));
    app.get("/v1/invoices/share/:token", () => { throw new Error("recipient@example.com secret-token"); });
    app.onError((error) => { throw error; });

    await expect(app.request("/v1/invoices/share/abc")).rejects.toThrow();
    expect(JSON.stringify(lines)).not.toContain("recipient@example.com");
    expect(JSON.stringify(lines)).not.toContain("secret-token");
    expect(lines.at(-1)?.message).toBe(`${VERBOSE_INVOICE_SHARE} request threw`);
  });

  it("ハンドラが落ちた場合も出口の行が status 付きで残る", async () => {
    const { lines, logger } = recorder();
    // Hono が例外を 500 に変換するため、 出口の行には status=500 が載る。
    const res = await appWith(logger).request("/v1/invoices/share/abc/boom");
    expect(res.status).toBe(500);
    expect(lines).toHaveLength(2);
    expect(lines[1].message).toBe(`${VERBOSE_INVOICE_SHARE} response`);
    expect(lines[1].fields.status).toBe(500);
  });

  it("logger 未設定なら何もせず素通しする", async () => {
    const app = new Hono();
    app.use("/v1/invoices/share/*", invoiceShareAccessLog(undefined));
    app.get("/v1/invoices/share/:token", (c) => c.text("ok"));
    expect((await app.request("/v1/invoices/share/abc")).status).toBe(200);
  });

  it("info を持たない logger でも warn で記録する", async () => {
    const lines: Line[] = [];
    const warnOnly = { warn: (f: Record<string, unknown>, m?: string) => lines.push({ fields: f, message: m ?? "" }) };
    await appWith(warnOnly).request("/v1/invoices/share/abc");
    expect(lines).toHaveLength(2);
  });

  it("token が無いパスは none として記録する", () => {
    expect(tokenFingerprint(undefined)).toBe("none");
  });

  it("スクリプト配信パスは token として扱わない", () => {
    expect(tokenFromPath("/v1/invoices/share/passkey.js")).toBeUndefined();
    expect(tokenFromPath("/v1/invoices/share/passkey.js/private")).toBe("passkey.js");
    expect(tokenFromPath("/v1/invoices/share/abc")).toBe("abc");
    expect(tokenFromPath("/v1/invoices/share/abc/accept")).toBe("abc");
    expect(tokenFromPath("/v1/invoices/40")).toBeUndefined();
  });
});
