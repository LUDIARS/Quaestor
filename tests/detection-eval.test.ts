import { describe, it, expect } from "vitest";
import { computeDetectionDiff } from "../src/services/detection-eval.js";

describe("computeDetectionDiff", () => {
  const reference = {
    date: "2026-06-11",
    payee: "サイゼリヤ 中目黒店",
    total: 1820,
    items: JSON.stringify([{ name: "ミラノ風ドリア", price: 460 }]),
  };

  it("検出が真値と一致すれば match / hasDiff=false", () => {
    const diff = computeDetectionDiff(
      [
        { label: "payee", text: "サイゼリヤ 中目黒店" },
        { label: "date", text: "2026-06-11" },
        { label: "total", text: "¥1,820" },
        { label: "item-0", text: "ミラノ風ドリア" },
      ],
      reference,
    );
    expect(diff.hasDiff).toBe(false);
    expect(diff.matched).toBe(4);
    expect(diff.fields.find((f) => f.field === "total")?.status).toBe("match");
  });

  it("読み違い (近いが違う) は mismatch + hasDiff=true", () => {
    const diff = computeDetectionDiff(
      [
        { label: "payee", text: "サイゼリヤ 中目黒店" },
        { label: "date", text: "2026-06-11" },
        { label: "total", text: "1320" }, // 8→3 の読み違い
      ],
      reference,
    );
    const total = diff.fields.find((f) => f.field === "total");
    expect(total?.status).toBe("mismatch");
    expect(diff.hasDiff).toBe(true);
  });

  it("検出器が当てられなければ missing", () => {
    const diff = computeDetectionDiff(
      [{ label: "payee", text: "サイゼリヤ 中目黒店" }],
      reference,
    );
    expect(diff.fields.find((f) => f.field === "total")?.status).toBe("missing");
    expect(diff.fields.find((f) => f.field === "date")?.status).toBe("missing");
    expect(diff.hasDiff).toBe(true);
  });

  it("真値が無いフィールドは no_reference で集計対象外", () => {
    const diff = computeDetectionDiff(
      [{ label: "payee", text: "サイゼリヤ" }],
      { date: null, payee: "サイゼリヤ", total: null, items: null },
    );
    expect(diff.evaluated).toBe(1); // payee のみ
    expect(diff.fields.find((f) => f.field === "total")?.status).toBe("no_reference");
    expect(diff.hasDiff).toBe(false);
  });
});
