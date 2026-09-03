import { describe, it, expect } from "vitest";
import {
  computeOcrFitness, buildTextCandidates, extractDateTokens, extractAmountTokens, textSimilarity, containsScore,
  DEFAULT_FITNESS_WEIGHTS, MERGED_LINE_FACTOR,
} from "../src/services/ocr-ga-fitness.js";
import type { OcrLine } from "../src/services/ocr-sidecar-client.js";

function line(text: string, y: number, h = 20, x = 0, w = 200): OcrLine {
  return { polygon: [], bbox: [x, y, w, h], text, score: 0.9 };
}

const NONE = { date: null, payee: null, total: null, items: null };

describe("computeOcrFitness — 日付", () => {
  it("年月日・曜日・時刻付きの行から YYYYMMDD で一致させ hit にする", () => {
    const r = computeOcrFitness([line("2026年09月02日(水)16:56", 10)], { ...NONE, date: "2026-09-02" });
    expect(r.fieldHits.date).toBe(true);
    expect(r.fieldScores.date).toBe(1);
    // 真値が date だけなら重みは date に正規化され fitness = 1
    expect(r.fitness).toBe(1);
  });

  it("スラッシュ区切り・和暦 (R8.9.2) も同じ日付とみなす", () => {
    expect(computeOcrFitness([line("2026/9/2 16:56", 0)], { ...NONE, date: "2026-09-02" }).fieldHits.date).toBe(true);
    expect(computeOcrFitness([line("R8.9.2", 0)], { ...NONE, date: "2026-09-02" }).fieldHits.date).toBe(true);
    expect(computeOcrFitness([line("令和8年9月2日", 0)], { ...NONE, date: "2026-09-02" }).fieldHits.date).toBe(true);
  });

  it("月日だけ一致 (年が読めない) は部分点で hit にしない", () => {
    const r = computeOcrFitness([line("9/2 16:56", 0)], { ...NONE, date: "2026-09-02" });
    expect(r.fieldHits.date).toBe(false);
    expect(r.fieldScores.date).toBe(0.75);
  });

  it("違う日付は 1 にならず hit でもない", () => {
    const r = computeOcrFitness([line("2026/09/03", 0)], { ...NONE, date: "2026-09-02" });
    expect(r.fieldHits.date).toBe(false);
    expect(r.fieldScores.date!).toBeLessThan(1);
  });
});

describe("computeOcrFitness — 金額", () => {
  it("他のテキストが混ざる行 (合計 ¥4,080 (税込)) から total を復元する", () => {
    const r = computeOcrFitness([line("合計 ¥4,080 (税込)", 0)], { ...NONE, total: 4080 });
    expect(r.fieldHits.total).toBe(true);
    expect(r.fieldScores.total).toBe(1);
  });

  it("全角 (￥４，０８０円) も復元する", () => {
    const r = computeOcrFitness([line("￥４，０８０円", 0)], { ...NONE, total: 4080 });
    expect(r.fieldHits.total).toBe(true);
  });

  it("読み違い (4030) は部分点で hit にしない", () => {
    const r = computeOcrFitness([line("合計 4,030", 0)], { ...NONE, total: 4080 });
    expect(r.fieldHits.total).toBe(false);
    expect(r.fieldScores.total).toBe(0.75);
  });
});

describe("computeOcrFitness — 店名と隣接行結合", () => {
  const truth = { ...NONE, payee: "カスミ フードスクエア 志木店" };

  it("複数行に割れた payee を隣接行の結合で当てる (結合候補は 0.9 倍、hit は素の値)", () => {
    const r = computeOcrFitness([line("カスミ", 10), line("フードスクエア 志木店", 32)], truth);
    expect(r.fieldHits.payee).toBe(true);
    expect(r.fieldScores.payee).toBe(MERGED_LINE_FACTOR);
  });

  it("1 行に収まっていれば満点 (1 行加点)", () => {
    const r = computeOcrFitness([line("ｶｽﾐ フードスクエア 志木店", 10)], truth);
    expect(r.fieldScores.payee).toBe(1);
  });

  it("y が離れた行は結合しない", () => {
    const r = computeOcrFitness([line("カスミ", 10), line("フードスクエア 志木店", 300)], truth);
    expect(r.fieldHits.payee).toBe(false);
    expect(r.fieldScores.payee!).toBeLessThan(MERGED_LINE_FACTOR);
  });

  it("全角英字・小文字・空白の差は normalizePayee で吸収する", () => {
    const r = computeOcrFitness([line("ｓｕｐｅｒｍａｒｋｅｔ  kasumi", 0)], { ...NONE, payee: "SUPERMARKET KASUMI" });
    expect(r.fieldScores.payee).toBe(1);
  });

  it("店名の後ろに TEL 等が続く行でも丸ごと含んでいれば満点、逆に一部だけなら長さ比", () => {
    expect(computeOcrFitness([line("成城石井 TEL 03-0000-0000", 0)], { ...NONE, payee: "成城石井" }).fieldScores.payee).toBe(1);
    const partial = computeOcrFitness([line("カスミ", 0)], truth);
    expect(partial.fieldHits.payee).toBe(false);
    expect(partial.fieldScores.payee!).toBeLessThan(0.5);
  });
});

describe("computeOcrFitness — 重み・fieldHits・コスト項", () => {
  const truth = {
    date: "2026-09-02",
    payee: "成城石井",
    total: 1234,
    items: JSON.stringify([{ name: "牛乳", price: 220 }, { name: "食パン", price: 180 }]),
  };
  const perfect = [
    line("成城石井", 0), line("2026/09/02", 22), line("牛乳 220", 44), line("食パン 180", 66), line("合計 ¥1,234", 88),
  ];

  it("全フィールド一致で fitness 1、fieldHits 全 true", () => {
    const r = computeOcrFitness(perfect, truth);
    expect(r.fitness).toBe(1);
    expect(r.fieldHits).toEqual({ date: true, payee: true, total: true });
    expect(r.fieldScores).toEqual({ date: 1, payee: 1, total: 1, items: 1 });
  });

  it("重みは total 0.4 / date 0.3 / payee 0.2 / items 0.1", () => {
    expect(DEFAULT_FITNESS_WEIGHTS).toEqual({ total: 0.4, date: 0.3, payee: 0.2, items: 0.1 });
    // payee だけ外す → 0.4 + 0.3 + 0.1 = 0.8
    const r = computeOcrFitness(perfect.filter((l) => l.text !== "成城石井"), truth);
    expect(r.fitness).toBeCloseTo(0.8, 3);
    expect(r.fieldHits).toEqual({ date: true, payee: false, total: true });
  });

  it("真値の無いフィールドは重みから外して正規化する", () => {
    // items 無し: date と total だけ当たり payee 外れ → (0.4 + 0.3) / 0.9
    const r = computeOcrFitness([line("2026/09/02", 0), line("1234", 22)], { ...truth, items: null });
    expect(r.fieldScores.items).toBeNull();
    expect(r.fitness).toBeCloseTo(0.7 / 0.9, 3);
  });

  it("コスト項は評価秒数 × costPerSecond を引き、係数 0 なら引かない", () => {
    const withCost = computeOcrFitness(perfect, truth, { elapsedMs: 40_000, costPerSecond: 0.001 });
    expect(withCost.score).toBe(1);
    expect(withCost.costPenalty).toBe(0.04);
    expect(withCost.fitness).toBe(0.96);
    const noCost = computeOcrFitness(perfect, truth, { elapsedMs: 40_000, costPerSecond: 0 });
    expect(noCost.fitness).toBe(1);
  });

  it("行が無い / 真値が無いなら 0", () => {
    expect(computeOcrFitness([], truth).fitness).toBe(0);
    expect(computeOcrFitness(perfect, NONE).fitness).toBe(0);
  });
});

describe("ヘルパー", () => {
  it("extractDateTokens: 全角数字と月日だけの形式", () => {
    expect(extractDateTokens("２０２６年９月２日").full).toEqual(["20260902"]);
    expect(extractDateTokens("9/2").monthDay).toEqual(["0902"]);
    expect(extractDateTokens("13/45").full).toEqual([]);
  });

  it("extractAmountTokens: 桁区切りを外し、数字の並びを跨ぐカンマは区切りのまま", () => {
    expect(extractAmountTokens("¥1,234,567")).toEqual(["1234567"]);
    expect(extractAmountTokens("100, 200")).toEqual(["100", "200"]);
    expect(extractAmountTokens("小計 ¥3,980 税 ¥100")).toEqual(["3980", "100"]);
  });

  it("buildTextCandidates: y 順に並び、隣接 2〜3 行の結合候補を足す", () => {
    const c = buildTextCandidates([line("c", 44), line("a", 0), line("b", 22), line("", 66)]);
    expect(c.filter((x) => x.lineCount === 1).map((x) => x.text)).toEqual(["a", "b", "c"]);
    expect(c.find((x) => x.lineCount === 2 && x.text === "a b")).toBeTruthy();
    expect(c.find((x) => x.lineCount === 3 && x.text === "a b c")).toBeTruthy();
  });

  it("textSimilarity: 包含は長さ比、それ以外は Levenshtein 比", () => {
    const cases: Array<[string, string, number]> = [
      ["4080", "4080", 1],
      ["4080", "14080", 0.8],
      ["4080", "4030", 0.75],
      ["", "x", 0],
    ];
    for (const [a, b, expected] of cases) expect(textSimilarity(a, b), `${a} vs ${b}`).toBe(expected);
  });

  it("containsScore: 候補が真値を丸ごと含めば 1、一部なら長さ比、1 文字の真値は長さ比", () => {
    const cases: Array<[string, string, number]> = [
      ["牛乳", "牛乳220", 1],
      ["牛乳低脂肪", "牛乳", 0.4],
      ["卵", "卵10個", 0.25],
      ["abcd", "abxd", 0.75],
    ];
    for (const [target, candidate, expected] of cases) expect(containsScore(target, candidate), `${target} in ${candidate}`).toBe(expected);
  });
});
