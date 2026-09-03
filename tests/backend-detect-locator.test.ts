import { describe, it, expect } from "vitest";
import {
  BackendDetectFieldLocator, toRegions,
} from "../web/src/scanner/backend-detect-locator.js";
import { ChainedFieldLocator } from "../web/src/scanner/field-locator.js";
import type { DetectedRegion, FieldLocatorEngine, OcrFields } from "../web/src/scanner/types.js";

const FIELDS: OcrFields = {
  date: "2026-09-02",
  payee: "カスミ 志木店",
  total: 4080,
  items: JSON.stringify([{ name: "牛乳", price: 220 }]),
};

function backendRegion(field: string, text: string) {
  return {
    field,
    x: 10, y: 40, width: 190, height: 20,
    confidence: 0.93,
    recognizedText: text,
    polygon: [[10, 40], [200, 40], [200, 60], [10, 60]] as Array<[number, number]>,
  };
}

/** fetch 呼び出しを記録する stub。sidecar への直 fetch が起きていないことも見る */
function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

describe("BackendDetectFieldLocator (撮影時の検出は backend 経由)", () => {
  it("POST /v1/receipts/:id/detect を呼び、sidecar には直接 fetch しない", async () => {
    const { impl, calls } = fakeFetch({
      source: "real",
      regions: [backendRegion("payee", "カスミ 志木店")],
    });
    const locator = new BackendDetectFieldLocator("rcpt-1", impl);

    const out = await locator.locate("/v1/receipts/rcpt-1/image", 608, 1080, FIELDS, "receipt");

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("/v1/receipts/rcpt-1/detect");
    expect(calls[0]!.init?.method).toBe("POST");
    // ブラウザから sidecar (127.0.0.1:17350) を叩く経路は無い
    expect(calls.some((c) => c.url.includes("17350") || c.url.includes("/detect?"))).toBe(false);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ id: "payee", source: "real", persisted: true, recognizedText: "カスミ 志木店" });
  });

  it("source が real でなければ空を返し、chain の次段 (Tesseract → 比率推定) に譲る", async () => {
    const { impl } = fakeFetch({ source: null, reason: "sidecar_failed", regions: [] });
    const fallback: FieldLocatorEngine = {
      locate: async () => [{ id: "payee", label: "STORE NAME", x: 0, y: 0, width: 1, height: 1, confidence: 0.5 }],
    };
    const chain = new ChainedFieldLocator([new BackendDetectFieldLocator("rcpt-1", impl), fallback]);

    const out = await chain.locate("/img", 608, 1080, FIELDS, "receipt");
    expect(out.length).toBe(1);
    expect(out[0]!.source).toBeUndefined(); // fallback の heuristic 領域
  });

  it("時間切れ (backend は 1 回 40 秒) でも chain は次段へ進む", async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const fallback: FieldLocatorEngine = {
      locate: async () => [{ id: "date", label: "DATE", x: 0, y: 0, width: 1, height: 1, confidence: 0.5 }],
    };
    const chain = new ChainedFieldLocator([new BackendDetectFieldLocator("rcpt-1", hang, 20), fallback]);

    const out = await chain.locate("/img", 608, 1080, FIELDS, "receipt");
    expect(out.map((r) => r.id)).toEqual(["date"]);
  });

  it("backend が 5xx でも例外は chain が飲み、演出は止まらない", async () => {
    const { impl } = fakeFetch({ error: "boom" }, 500);
    const chain = new ChainedFieldLocator([new BackendDetectFieldLocator("rcpt-1", impl)]);
    await expect(chain.locate("/img", 608, 1080, FIELDS, "receipt")).resolves.toEqual([]);
  });
});

describe("toRegions (backend 領域 → 演出用 DetectedRegion)", () => {
  it("表示ラベル・色・値を web 側で付け、backend 保存済 (persisted) を立てる", () => {
    const out: DetectedRegion[] = toRegions(
      [
        backendRegion("payee", "カスミ 志木店"),
        backendRegion("date", "2026年09月02日"),
        backendRegion("total", "合計 ¥4,080"),
        backendRegion("item-0", "牛乳 220"),
      ],
      FIELDS,
    );

    expect(out.map((r) => r.label)).toEqual(["STORE NAME", "DATE", "TOTAL", "ITEM"]);
    expect(out.map((r) => r.value)).toEqual(["カスミ 志木店", "2026-09-02", "¥4,080", "牛乳  ¥220"]);
    expect(out.every((r) => r.source === "real" && r.persisted === true)).toBe(true);
    expect(out.every((r) => r.polygon?.length === 4)).toBe(true);
    // 演出は上から順に 850ms 刻みで出す (既存 locator と同じ)
    expect(out.map((r) => r.delay)).toEqual([0, 850, 1700, 2550]);
  });

  it("真値 items が壊れていても item 領域は落とさない (値だけ空)", () => {
    const out = toRegions([backendRegion("item-0", "牛乳 220")], { ...FIELDS, items: "{ broken" });
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ label: "ITEM", value: undefined, source: "real" });
  });
});
