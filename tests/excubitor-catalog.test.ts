import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearServiceEndpointCache, portFromCatalog, resolveServiceBaseUrl,
} from "../src/services/excubitor-catalog.js";

const CATALOG = `# fragment
services:
  - code: concordia
    name: Concordia
    port: 24680
    health:
      type: http
      url: http://localhost:24680/health
    env:
      SOME_PORT: "9999"
  - code: concordia-worker
    name: worker
    runtime: node
`;

describe("portFromCatalog", () => {
  it("reads the port of the requested service only", () => {
    expect(portFromCatalog(CATALOG, "concordia")).toBe(24680);
    expect(portFromCatalog(CATALOG, "concordia-worker")).toBeNull();
    expect(portFromCatalog(CATALOG, "absent")).toBeNull();
  });
});

describe("resolveServiceBaseUrl", () => {
  let arsRoot: string;

  beforeEach(() => {
    clearServiceEndpointCache();
    arsRoot = mkdtempSync(join(tmpdir(), "quaestor-catalog-"));
    mkdirSync(join(arsRoot, "Concordia"));
    writeFileSync(join(arsRoot, "Concordia", "excubitor.catalog.yaml"), CATALOG, "utf8");
  });

  afterEach(() => {
    clearServiceEndpointCache();
    rmSync(arsRoot, { recursive: true, force: true });
  });

  it("prefers the endpoint injected from the catalog provides block", () => {
    expect(resolveServiceBaseUrl("concordia", {
      arsRoot,
      envName: "CONCORDIA_URL",
      env: { CONCORDIA_URL: "http://127.0.0.1:13579/" },
      useCache: false,
    })).toBe("http://127.0.0.1:13579");
  });

  it("falls back to the port declared by the owning repository fragment", () => {
    expect(resolveServiceBaseUrl("concordia", { arsRoot, env: {}, useCache: false }))
      .toBe("http://127.0.0.1:24680");
  });

  it("rejects injected endpoints outside loopback", () => {
    expect(resolveServiceBaseUrl("concordia", {
      arsRoot,
      envName: "CONCORDIA_URL",
      env: { CONCORDIA_URL: "https://attacker.example/delegation" },
      useCache: false,
    })).toBeNull();
  });

  it("returns null when no fragment declares the service", () => {
    expect(resolveServiceBaseUrl("nowhere", { arsRoot, env: {}, useCache: false })).toBeNull();
  });
});
