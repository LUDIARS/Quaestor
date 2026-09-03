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

describe("GET /v1/ocr-ga (世代更新 API は B-1 で撤去済)", () => {
  let root: string;
  let gaRoot: string;
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qgaapi-"));
    gaRoot = join(root, "ga");
    app = buildApp({ db: new Database(":memory:"), gaRoot });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("GET /best は記録が無ければ default を返す", async () => {
    const res = await app.request("/v1/ocr-ga/best?tags=long,faded");
    expect(res.status).toBe(200);
    const j = await res.json() as { source: string; genome: unknown };
    expect(j.source).toBe("default");
    expect(j.genome).toEqual(defaultOcrGenome());
  });

  it("GET /population の payee 由来キーは global に丸め、店舗別ファイルを作らない", async () => {
    const pop = await (await app.request("/v1/ocr-ga/population?key=サイゼリヤ")).json() as { key: string; genomes: unknown[] };
    expect(pop.key).toBe("global");
    expect(pop.genomes.length).toBe(8);
    expect(readdirSync(gaRoot).filter((f) => f.endsWith(".json"))).toEqual(["global.json"]);
  });

  it("tag:<x> は別集団、GET /best?tags= はタグ優先で引く", async () => {
    const store = createOcrGaStore(gaRoot);
    const genome = { ...defaultOcrGenome(), detThresh: 0.25 };
    store.recordGeneration("global", [{ genome, fitness: 0.5 }]);
    store.recordGeneration("tag:long", [{ genome, fitness: 0.45 }]);
    expect(existsSync(join(gaRoot, "tag_long.json"))).toBe(true);

    const tagged = await (await app.request("/v1/ocr-ga/best?tags=long")).json() as { key: string; source: string; fitness: number };
    expect(tagged).toMatchObject({ key: "tag:long", source: "tag", fitness: 0.45 });
    const other = await (await app.request("/v1/ocr-ga/best?tags=faded")).json() as { key: string; source: string };
    expect(other).toMatchObject({ key: "global", source: "global" });
  });

  it("撮影時の世代更新 (POST /generation) は無くなった — 世代を進めるのは夜間バッチだけ", async () => {
    const res = await app.request("/v1/ocr-ga/generation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "global", evaluated: [{ genome: defaultOcrGenome(), fitness: 0.7 }] }),
    });
    expect(res.status).toBe(404);
  });
});
