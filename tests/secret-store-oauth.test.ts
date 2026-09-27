import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretStore } from "../src/services/secret-store.js";

describe("atomic OAuth secret persistence", () => {
  it("preserves unrelated secrets and never writes plaintext credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oauth-"));
    try {
      const file = join(root, "secrets.enc.json");
      const store = new SecretStore({ file, keyFile: join(root, "key") });
      store.set("OTHER", "keep");
      store.setMany({ CLIENT: "client-fixture", REFRESH: "refresh-fixture" });
      expect(store.loadStrict()).toEqual({ OTHER: "keep", CLIENT: "client-fixture", REFRESH: "refresh-fixture" });
      expect(readFileSync(file, "utf8")).not.toContain("refresh-fixture");
      writeFileSync(file, "broken encrypted store");
      expect(() => store.setMany({ REFRESH: "replacement" })).toThrow("secret store unavailable");
      expect(readFileSync(file, "utf8")).toBe("broken encrypted store");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
