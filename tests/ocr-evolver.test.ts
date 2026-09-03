import { afterEach, describe, expect, it, vi } from "vitest";
import { OcrEvolver, type OcrCandidate } from "../web/src/scanner/ocr-evolver.js";
import type { OcrGenome } from "../web/src/scanner/ocr-genome.js";

const genome: OcrGenome = {
  detThresh: 0.3, boxThresh: 0.6, unclipRatio: 1.6,
  limitSideLen: 960, useDilation: false, dropScore: 0.5,
};

afterEach(() => vi.unstubAllGlobals());

describe("legacy OcrEvolver generation compatibility", () => {
  it("payee があっても global を期待世代付きで 1 回だけ更新する", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const evolver = new OcrEvolver();
    Object.assign(evolver as unknown as { generation: number; candidates: OcrCandidate[] }, {
      generation: 7,
      candidates: [{ genome, lines: [{ polygon: [], bbox: [0, 0, 10, 10] as [number, number, number, number], text: "店舗", score: 1 }] }],
    });

    await evolver.finalize({ payee: "店舗", date: null, total: null, items: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ key: "global", expectedGeneration: 7 });
  });
});
