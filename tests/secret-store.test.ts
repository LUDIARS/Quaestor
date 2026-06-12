import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../src/services/secret-store.js";

describe("secret-store (§7.2 暗号化保存)", () => {
  let dir: string;
  let store: SecretStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qsec-"));
    store = new SecretStore({
      file: join(dir, "data", "secrets.enc.json"),
      keyFile: join(dir, "keys", "secret.key"), // 本体と分離したディレクトリ
    });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("set → load が round-trip し、ファイルに平文が残らない", () => {
    store.set("ANTHROPIC_API_KEY", "sk-ant-test-12345");
    expect(store.load()).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test-12345" });

    const raw = readFileSync(join(dir, "data", "secrets.enc.json"), "utf8");
    expect(raw).not.toContain("sk-ant-test-12345");
    expect(raw).not.toContain("ANTHROPIC_API_KEY"); // キー名も暗号文の中
    const enc = JSON.parse(raw) as { alg: string };
    expect(enc.alg).toBe("aes-256-gcm");
  });

  it("names は参照名のみ、remove で消える", () => {
    store.set("A_KEY", "v1");
    store.set("B_KEY", "v2");
    expect(store.names()).toEqual(["A_KEY", "B_KEY"]);
    expect(store.remove("A_KEY")).toBe(true);
    expect(store.remove("A_KEY")).toBe(false);
    expect(store.names()).toEqual(["B_KEY"]);
  });

  it("injectIntoEnv は未設定キーのみ注入する", () => {
    const prevA = process.env.QSEC_TEST_A;
    const prevB = process.env.QSEC_TEST_B;
    try {
      store.set("QSEC_TEST_A", "from-store");
      store.set("QSEC_TEST_B", "from-store");
      process.env.QSEC_TEST_A = "from-env";
      delete process.env.QSEC_TEST_B;

      const injected = store.injectIntoEnv();
      expect(injected).toEqual(["QSEC_TEST_B"]);
      expect(process.env.QSEC_TEST_A).toBe("from-env"); // env が勝つ
      expect(process.env.QSEC_TEST_B).toBe("from-store");
    } finally {
      if (prevA === undefined) delete process.env.QSEC_TEST_A; else process.env.QSEC_TEST_A = prevA;
      if (prevB === undefined) delete process.env.QSEC_TEST_B; else process.env.QSEC_TEST_B = prevB;
    }
  });

  it("鍵ファイルが無いと復号できず {} (起動は止めない)", () => {
    store.set("X", "secret-value");
    const noKey = new SecretStore({
      file: join(dir, "data", "secrets.enc.json"),
      keyFile: join(dir, "keys2", "secret.key"), // 存在しない鍵
    });
    expect(noKey.load()).toEqual({});
    expect(store.load()).toEqual({ X: "secret-value" }); // 正しい鍵では読める
  });
});
