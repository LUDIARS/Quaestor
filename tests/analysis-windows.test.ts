import { describe, it, expect } from "vitest";
import { enumerateDays, resolveWindow } from "../src/services/household/analysis-windows.js";

describe("analysis windows", () => {
  it("week は月曜起点で anchor を含み、 前期間は直前 7 日", () => {
    const w = resolveWindow("week", "2026-09-03"); // 木曜
    expect(w.current).toEqual({ from: "2026-08-31", to: "2026-09-06" });
    expect(w.previous).toEqual({ from: "2026-08-24", to: "2026-08-30" });
  });

  it("week: 月曜と日曜が端になる", () => {
    expect(resolveWindow("week", "2026-08-31").current.from).toBe("2026-08-31");
    expect(resolveWindow("week", "2026-09-06").current.from).toBe("2026-08-31");
  });

  it("month は anchor の月、 前期間は前月 (年跨ぎ)", () => {
    const w = resolveWindow("month", "2026-01-15");
    expect(w.current).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(w.previous).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(w.label).toBe("2026-01");
  });

  it("month: うるう年 2 月の月末", () => {
    expect(resolveWindow("month", "2028-02-10").current.to).toBe("2028-02-29");
  });

  it("quarter / half / year は anchor 月を末尾とする n ヶ月", () => {
    const q = resolveWindow("quarter", "2026-03-31");
    expect(q.current).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(q.previous).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    const h = resolveWindow("half", "2026-02-01");
    expect(h.current).toEqual({ from: "2025-09-01", to: "2026-02-28" });
    expect(h.previous).toEqual({ from: "2025-03-01", to: "2025-08-31" });
    const y = resolveWindow("year", "2026-09-03");
    expect(y.current).toEqual({ from: "2025-10-01", to: "2026-09-30" });
    expect(y.previous).toEqual({ from: "2024-10-01", to: "2025-09-30" });
    expect(y.label).toBe("2025-10〜2026-09");
  });

  it("enumerateDays は両端含む", () => {
    expect(enumerateDays({ from: "2026-02-27", to: "2026-03-02" })).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });

  it("不正な日付は例外", () => {
    expect(() => resolveWindow("month", "2026-13-01")).toThrow();
  });
});
