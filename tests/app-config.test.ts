import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig, sidecarUrlOf } from "../src/services/app-config.js";

const ENV_KEYS = [
  "QUAESTOR_HOST", "QUAESTOR_PORT", "QUAESTOR_LOG_LEVEL",
  "QUAESTOR_DB", "QUAESTOR_RECEIPTS_ROOT",
  "QUAESTOR_OCR_WORKER", "QUAESTOR_OCR_INTERVAL_MS",
  "QUAESTOR_OCR_SIDECAR_MANAGE", "QUAESTOR_OCR_SIDECAR_PORT",
  "QUAESTOR_OCR_SIDECAR_URL", "QUAESTOR_OCR_LANG", "QUAESTOR_OCR_PYTHON",
  "QUAESTOR_PUBLIC_URL", "QUAESTOR_INVOICE_SHARE_ROOTS",
  "QUAESTOR_SES_REGION", "QUAESTOR_SES_FROM_ADDRESS", "QUAESTOR_SES_CONFIGURATION_SET",
];

describe("app-config loader (§7.1)", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcfg-"));
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("ファイル無しなら既定値で動く", () => {
    const c = loadAppConfig(join(dir, "missing.json"));
    expect(c.server.port).toBe(17400);
    expect(c.ocrSidecar.port).toBe(17350);
    expect(c.ocrSidecar.manage).toBe(true);
    expect(sidecarUrlOf(c)).toBe("http://127.0.0.1:17350");
  });

  it("ファイル値が既定値を上書きする", () => {
    const p = join(dir, "q.json");
    writeFileSync(p, JSON.stringify({
      server: { port: 18000 },
      ocrSidecar: {
        manage: false, lang: "en",
        venvPython: "C:\\Python39\\python.exe",
        externalUrl: "http://10.0.0.5:17350",
      },
    }), "utf8");
    const c = loadAppConfig(p);
    expect(c.server.port).toBe(18000);
    expect(c.server.host).toBe("127.0.0.1"); // 欠けたキーは既定値
    expect(c.ocrSidecar.manage).toBe(false);
    expect(c.ocrSidecar.lang).toBe("en");
    expect(c.ocrSidecar.venvPython).toBe("C:\\Python39\\python.exe");
    expect(sidecarUrlOf(c)).toBe("http://10.0.0.5:17350");
  });

  it("venvPython 未指定は null (自動探索)", () => {
    const c = loadAppConfig(join(dir, "missing.json"));
    expect(c.ocrSidecar.venvPython).toBeNull();
  });

  it("env はファイルより優先 (override のみ)", () => {
    const p = join(dir, "q.json");
    writeFileSync(p, JSON.stringify({ server: { port: 18000 } }), "utf8");
    process.env.QUAESTOR_PORT = "19000";
    process.env.QUAESTOR_OCR_WORKER = "0";
    const c = loadAppConfig(p);
    expect(c.server.port).toBe(19000);
    expect(c.ocrWorker.enabled).toBe(false);
  });

  it("invoiceShare: 既定は publicUrl 未設定、 env/ファイルで解決する", () => {
    const bare = loadAppConfig(join(dir, "missing.json"));
    expect(bare.invoiceShare.publicUrl).toBeNull();
    expect(bare.invoiceShare.roots).toEqual(["data", "app_data/invoices"]);

    const p = join(dir, "q.json");
    writeFileSync(p, JSON.stringify({
      invoiceShare: { publicUrl: "https://from-file.example.com", roots: ["app_data/invoices"] },
    }), "utf8");
    expect(loadAppConfig(p).invoiceShare.publicUrl).toBe("https://from-file.example.com");

    process.env.QUAESTOR_PUBLIC_URL = "https://qs.example.com";
    process.env.QUAESTOR_INVOICE_SHARE_ROOTS = " data ; app_data/invoices ;";
    const c = loadAppConfig(p);
    expect(c.invoiceShare.publicUrl).toBe("https://qs.example.com");
    expect(c.invoiceShare.roots).toEqual(["data", "app_data/invoices"]);
  });

  it("invoiceShare.email: 既定は全 null、 ファイルで読め、 env がファイルより優先する", () => {
    const bare = loadAppConfig(join(dir, "missing.json"));
    expect(bare.invoiceShare.email).toEqual({ region: null, fromAddress: null, configurationSet: null });

    const p = join(dir, "q.json");
    writeFileSync(p, JSON.stringify({
      invoiceShare: {
        email: {
          region: "ap-northeast-1",
          fromAddress: "invoice@example.com",
          configurationSet: "invoice-set",
        },
      },
    }), "utf8");
    const fromFile = loadAppConfig(p);
    expect(fromFile.invoiceShare.email).toEqual({
      region: "ap-northeast-1",
      fromAddress: "invoice@example.com",
      configurationSet: "invoice-set",
    });

    process.env.QUAESTOR_SES_REGION = "us-east-1";
    process.env.QUAESTOR_SES_FROM_ADDRESS = "billing@example.com";
    process.env.QUAESTOR_SES_CONFIGURATION_SET = "override-set";
    const withEnv = loadAppConfig(p);
    expect(withEnv.invoiceShare.email).toEqual({
      region: "us-east-1",
      fromAddress: "billing@example.com",
      configurationSet: "override-set",
    });
  });

  it("壊れた JSON は既定値で起動を止めない", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{ not json", "utf8");
    const c = loadAppConfig(p);
    expect(c.server.port).toBe(17400);
  });
});
