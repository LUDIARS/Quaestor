import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli/ga-bench.js";

describe("ga:bench CLI の引数解析", () => {
  it("タスク指定の形 (--label --generations --limit --population --out) を読む", () => {
    const a = parseArgs(["--label", "global", "--generations", "1", "--limit", "20", "--population", "4", "--out", "tmp/ga-bench"]);
    expect(a).toMatchObject({ labels: ["global"], generations: 1, limit: 20, population: 4, out: "tmp/ga-bench", help: false });
  });

  it("--label は複数、--device / --sidecar / --cost-per-second / --db を受ける", () => {
    const a = parseArgs(["--label", "global", "--label", "tag:long", "--device", "gpu", "--sidecar", "http://127.0.0.1:17351", "--cost-per-second", "0", "--db", "x.db"]);
    expect(a.labels).toEqual(["global", "tag:long"]);
    expect(a.device).toBe("gpu");
    expect(a.sidecar).toBe("http://127.0.0.1:17351");
    expect(a.costPerSecond).toBe(0);
    expect(a.db).toBe("x.db");
  });

  it("既定は generations 1 / 全ラベル", () => {
    expect(parseArgs([])).toEqual({ labels: [], generations: 1, help: false });
  });

  it("不正値は例外 (黙って既定にしない)", () => {
    expect(() => parseArgs(["--generations", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--device", "tpu"])).toThrow(/cpu or gpu/);
    expect(() => parseArgs(["--label"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--cost-per-second", "-1"])).toThrow(/non-negative/);
  });
});
