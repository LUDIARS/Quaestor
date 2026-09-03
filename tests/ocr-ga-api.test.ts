import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { defaultOcrGenome, normalizeGaKey, tagGaKey, normalizeTag, resolveBestGenome, createOcrGaStore } from "../src/services/ocr-ga.js";

describe("ocr-ga key 規則", () => {
  it("normalizeGaKey: global と tag:<正規タグ> だけ通し、それ以外 (旧 payee キー) は global", () => {
    expect(normalizeGaKey(undefined)).toBe("global");
    expect(normalizeGaKey("global")).toBe("global");
    expect(normalizeGaKey("tag:long")).toBe("tag:long");
    expect(normalizeGaKey("tag:Multi Column")).toBe("tag:multi_column");
    expect(normalizeGaKey("tag:")).toBe("global");
    expect(normalizeGaKey("サイゼリヤ_中目黒")).toBe("global");
    expect(normalizeGaKey("KASUMI")).toBe("global");
  });

  it("normalizeTag / tagGaKey", () => {
    expect(normalizeTag(" Low-Light ")).toBe("low_light");
    expect(normalizeTag("日本語")).toBeNull();
    expect(tagGaKey("faded")).toBe("tag:faded");
    expect(tagGaKey("")).toBeNull();
  });
});

describe("resolveBestGenome のフォールバック順 (tag → global → default)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qgabest-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("記録が無ければ default、global に記録があれば global、タグに記録があればタグ優先", () => {
    const store = createOcrGaStore(join(root, "ga"));
    expect(resolveBestGenome(store, ["long"])).toEqual({ key: "global", source: "default", generation: 0, fitness: null, genome: defaultOcrGenome() });

    const g = store.population("global").genomes;
    store.recordGeneration("global", [{ genome: g[0]!, fitness: 0.4 }, { genome: g[1]!, fitness: 0.6 }]);
    const fromGlobal = resolveBestGenome(store, ["long"]);
    expect(fromGlobal.source).toBe("global");
    expect(fromGlobal.fitness).toBe(0.6);
    expect(fromGlobal.genome).toEqual(g[1]);

    const t = store.population("tag:long").genomes;
    store.recordGeneration("tag:long", [{ genome: t[2]!, fitness: 0.55 }]);
    const fromTag = resolveBestGenome(store, ["faded", "long"]);
    expect(fromTag).toMatchObject({ key: "tag:long", source: "tag", generation: 1, fitness: 0.55, genome: t[2] });
    // 集団ファイルを seed しただけ (population 呼び出し) で記録の無いタグは飛ばして global
    store.population("tag:faded");
    expect(resolveBestGenome(store, ["faded"]).source).toBe("global");
  });
});

describe("GET/POST /v1/ocr-ga", () => {
  let root: string;
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qgaapi-"));
    app = buildApp({ db: new Database(":memory:"), gaRoot: join(root, "ga") });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("GET /best は記録が無ければ default を返す", async () => {
    const res = await app.request("/v1/ocr-ga/best?tags=long,faded");
    expect(res.status).toBe(200);
    const j = await res.json() as { source: string; genome: unknown };
    expect(j.source).toBe("default");
    expect(j.genome).toEqual(defaultOcrGenome());
  });

  it("POST /generation の payee 由来キーは global に丸め、店舗別ファイルを作らない", async () => {
    const pop = await (await app.request("/v1/ocr-ga/population?key=サイゼリヤ")).json() as { key: string; genomes: unknown[] };
    expect(pop.key).toBe("global");
    const res = await app.request("/v1/ocr-ga/generation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "サイゼリヤ", evaluated: [{ genome: defaultOcrGenome(), fitness: 0.7 }] }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { key: string; generation: number };
    expect(j.key).toBe("global");
    expect(j.generation).toBe(1);
    expect(readdirSync(join(root, "ga")).filter((f) => f.endsWith(".json"))).toEqual(["global.json"]);

    const best = await (await app.request("/v1/ocr-ga/best")).json() as { source: string; fitness: number; key: string };
    expect(best.source).toBe("global");
    expect(best.fitness).toBe(0.7);
  });

  it("tag:<x> は別集団、GET /best?tags= はタグ優先で引く", async () => {
    const post = (key: string, fitness: number) => app.request("/v1/ocr-ga/generation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, evaluated: [{ genome: { ...defaultOcrGenome(), detThresh: 0.25 }, fitness }] }),
    });
    expect((await post("global", 0.5)).status).toBe(200);
    expect((await post("tag:long", 0.45)).status).toBe(200);
    expect(existsSync(join(root, "ga", "tag_long.json"))).toBe(true);

    const tagged = await (await app.request("/v1/ocr-ga/best?tags=long")).json() as { key: string; source: string; fitness: number };
    expect(tagged).toMatchObject({ key: "tag:long", source: "tag", fitness: 0.45 });
    const other = await (await app.request("/v1/ocr-ga/best?tags=faded")).json() as { key: string; source: string };
    expect(other).toMatchObject({ key: "global", source: "global" });
  });

  it("POST /generation の不正 body は 400", async () => {
    const res = await app.request("/v1/ocr-ga/generation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluated: [{ genome: {}, fitness: 2 }] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /generation は期待世代が古ければ 409 で拒否する", async () => {
    const body = { key: "global", expectedGeneration: 0, evaluated: [{ genome: defaultOcrGenome(), fitness: 0.7 }] };
    expect((await app.request("/v1/ocr-ga/generation", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).status).toBe(200);
    const stale = await app.request("/v1/ocr-ga/generation", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ generation: 1 });
  });
});
