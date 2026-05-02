import { describe, it, expect } from "vitest";
import { normalizeDate, parseAmount, normalizePayee } from "../src/shared/text.js";

describe("normalizeDate", () => {
  it("parses 4 formats", () => {
    expect(normalizeDate("2025年1月10日")).toBe("2025-01-10");
    expect(normalizeDate("2025/1/10")).toBe("2025-01-10");
    expect(normalizeDate("2025-1-10")).toBe("2025-01-10");
    expect(normalizeDate("1/10", 2025)).toBe("2025-01-10");
    expect(normalizeDate("1月10日", 2025)).toBe("2025-01-10");
  });

  it("rejects invalid dates", () => {
    expect(normalizeDate("2025/2/30")).toBeNull();
    expect(normalizeDate("2025/13/1")).toBeNull();
    expect(normalizeDate("garbage")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });

  it("requires defaultYear for shorthand", () => {
    expect(normalizeDate("1/10")).toBeNull();
  });
});

describe("parseAmount", () => {
  it("strips commas, spaces, fullwidth", () => {
    expect(parseAmount("1,234")).toBe(1234);
    expect(parseAmount("１，２３４")).toBe(1234);
    expect(parseAmount(" 1 234 ")).toBe(1234);
  });

  it("handles minus signs", () => {
    expect(parseAmount("-500")).toBe(-500);
    expect(parseAmount("−500")).toBe(-500);
    expect(parseAmount("ー500")).toBe(-500);
  });

  it("returns null for invalid", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe("normalizePayee", () => {
  it("upcases, fullwidth → halfwidth, collapses spaces", () => {
    expect(normalizePayee("ＡＭＡＺＯＮ.co.jp")).toBe("AMAZON.CO.JP");
    expect(normalizePayee("  Notion　Labs  ")).toBe("NOTION LABS");
  });
});
