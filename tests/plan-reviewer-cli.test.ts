import { describe, it, expect } from "vitest";
import {
  ClaudeCliPlanReviewer,
  extractEnvelopeResult,
  extractJsonObject,
  buildCliPrompt,
} from "../src/services/plan-reviewer-cli.js";
import type { PlanReviewInput } from "../src/services/plan-reviewer.js";

const input: PlanReviewInput = {
  templateName: "自由形式",
  purpose: "funding",
  sections: [{ title: "事業概要", body: "カフェを開業する" }],
  financialSummary: "- Y1: 売上1000万 営業利益200万",
};

describe("extractEnvelopeResult", () => {
  it("--output-format json のエンベロープから result を取り出す", () => {
    const env = JSON.stringify({ type: "result", result: "ここが本文", total_cost_usd: 0.01 });
    expect(extractEnvelopeResult(env)).toBe("ここが本文");
  });
  it("イベント配列 [{type:system},...,{type:result}] から result を取り出す", () => {
    const arr = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "assistant", message: {} },
      { type: "result", result: "配列の本文", total_cost_usd: 0.02 },
    ]);
    expect(extractEnvelopeResult(arr)).toBe("配列の本文");
  });
  it("NDJSON (1行1イベント) からも result を取り出す", () => {
    const nd = '{"type":"system"}\n{"type":"result","result":"NDの本文"}';
    expect(extractEnvelopeResult(nd)).toBe("NDの本文");
  });
  it("JSON でなければ生 stdout を返す", () => {
    expect(extractEnvelopeResult("  なまの文字列  ")).toBe("なまの文字列");
  });
});

describe("extractJsonObject", () => {
  it("```json フェンス内の JSON を抽出", () => {
    const obj = extractJsonObject('前置き\n```json\n{"score": 80, "summary": "良い", "findings": []}\n```\n後置き');
    expect(obj).toMatchObject({ score: 80, summary: "良い" });
  });
  it("生テキスト中の { .. } を抽出", () => {
    const obj = extractJsonObject('結果は {"score": 50, "findings": []} です');
    expect(obj).toMatchObject({ score: 50 });
  });
  it("JSON が無ければ null", () => {
    expect(extractJsonObject("ただの文章")).toBeNull();
  });
});

describe("buildCliPrompt", () => {
  it("system + 記述 + 数字 + JSON 出力指示を含む", () => {
    const p = buildCliPrompt(input);
    expect(p).toContain("中小企業診断士");
    expect(p).toContain("事業概要");
    expect(p).toContain("売上1000万");
    expect(p).toContain('"score"');
  });
});

describe("ClaudeCliPlanReviewer.review — runner 注入", () => {
  it("エンベロープ→JSON抽出→正規化まで通す", async () => {
    const fakeStdout = JSON.stringify({
      type: "result",
      result: '```json\n{"score": 65, "summary": "市場分析が薄い", "findings": [{"severity":"warning","area":"事業概要","message":"競合が不明","suggestion":"競合3社を比較"}]}\n```',
    });
    const reviewer = new ClaudeCliPlanReviewer({ runner: async () => fakeStdout });
    const r = await reviewer.review(input);
    expect(r.score).toBe(65);
    expect(r.summary).toBe("市場分析が薄い");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("warning");
    expect(r.findings[0]!.code).toBe("qualitative");
    expect(reviewer.modelName).toBe("claude-cli");
  });

  it("JSON 抽出不能なら throw", async () => {
    const reviewer = new ClaudeCliPlanReviewer({ runner: async () => "ごめん分かりません" });
    await expect(reviewer.review(input)).rejects.toThrow();
  });
});
