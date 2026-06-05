import { describe, it, expect } from "vitest";
import { parseStooqCsv, summarizeQuote, StooqStockClient } from "../src/services/stock-client.js";

describe("parseStooqCsv", () => {
  it("parses daily CSV into ascending bars", () => {
    const csv = `Date,Open,High,Low,Close,Volume
2025-04-01,3500,3520,3480,3510,1000
2025-04-02,3510,3560,3500,3550,1200
2025-04-03,3550,3600,3540,3590,900`;
    const bars = parseStooqCsv(csv);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toEqual({ date: "2025-04-01", close: 3510 });
    expect(bars[2]!.close).toBe(3590);
  });

  it("returns empty for no-data / malformed responses", () => {
    expect(parseStooqCsv("No data")).toEqual([]);
    expect(parseStooqCsv("")).toEqual([]);
    expect(parseStooqCsv("Date,Close\nfoo,bar")).toEqual([]);
  });
});

describe("summarizeQuote", () => {
  it("computes period change_pct from window endpoints", () => {
    const history = {
      ticker: "9999",
      as_of: "2025-04-30",
      bars: [
        { date: "2025-01-01", close: 1000 },   // 期間外 (90d より前)
        { date: "2025-04-01", close: 2000 },
        { date: "2025-04-30", close: 2200 },
      ],
    };
    const s = summarizeQuote(history, 90)!;
    expect(s.as_of).toBe("2025-04-30");
    expect(s.close).toBe(2200);
    expect(s.prev_close).toBe(2000);
    expect(s.change_pct).toBe(10);   // (2200-2000)/2000 = 10%
  });

  it("returns null when no finite bars", () => {
    expect(summarizeQuote({ ticker: "x", as_of: "", bars: [] }, 90)).toBeNull();
  });
});

describe("StooqStockClient", () => {
  it("fetches and parses via injected fetch", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("8267.jp");
      return new Response("Date,Close\n2025-04-01,3000\n2025-04-02,3100", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new StooqStockClient({ baseUrl: "https://example.test", fetchImpl: fakeFetch });
    const h = await client.history("8267");
    expect(h?.bars).toHaveLength(2);
    expect(h?.as_of).toBe("2025-04-02");
  });

  it("returns null on HTTP error", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const client = new StooqStockClient({ fetchImpl: fakeFetch });
    expect(await client.history("0000")).toBeNull();
  });
});
