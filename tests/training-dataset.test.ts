import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrainingDataset } from "../src/services/training-dataset.js";

describe("TrainingDataset", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qtrain-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function sampleRecord(id = "r1") {
    return {
      receiptId: id,
      imageRef: null,
      naturalWidth: 1000,
      naturalHeight: 2000,
      engine: "paddle",
      regions: [
        { label: "payee", x: 100, y: 50, width: 400, height: 60, text: "サイゼリヤ" },
        { label: "total", x: 600, y: 1800, width: 300, height: 80, text: "1820" },
        { label: "item-0", x: 80, y: 600, width: 800, height: 40, text: "ミラノ風ドリア" },
      ],
      ts: 1_700_000_000,
    };
  }

  it("append が jsonl + 個別 json を書き、count を増やす", () => {
    const ds = new TrainingDataset(join(root, "ds"));
    expect(ds.count()).toBe(0);
    ds.append(sampleRecord("r1"));
    ds.append(sampleRecord("r2"));
    expect(ds.count()).toBe(2);

    const jsonl = readFileSync(join(root, "ds", "regions.jsonl"), "utf8").trim().split("\n");
    expect(jsonl).toHaveLength(2);
    expect(JSON.parse(jsonl[0]!).receiptId).toBe("r1");
    expect(existsSync(join(root, "ds", "records", "r2.json"))).toBe(true);
  });

  it("空 regions は無視する", () => {
    const ds = new TrainingDataset(join(root, "ds"));
    ds.append({ ...sampleRecord(), regions: [] });
    expect(ds.count()).toBe(0);
  });

  it("遅れて完了した評価は別 engine の新しい snapshot を上書きしない", () => {
    const ds = new TrainingDataset(join(root, "ds"));
    const tesseract = ds.append({ ...sampleRecord(), engine: "tesseract", ts: 100 })!;
    const paddle = ds.append({ ...sampleRecord(), engine: "paddle", ts: 101 })!;

    expect(ds.attachEval(tesseract, { source: "old" }, { note: "slow" })).toBe(false);
    const current = JSON.parse(
      readFileSync(join(root, "ds", "records", "r1.json"), "utf8"),
    ) as { attemptId: string; engine: string; diff?: unknown; evaluation?: unknown };
    expect(current).toMatchObject({ attemptId: paddle.attemptId, engine: "paddle" });
    expect(current.diff).toBeUndefined();
    expect(current.evaluation).toBeUndefined();

    const evals = readFileSync(join(root, "ds", "evals.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(evals[0]!)).toMatchObject({
      attemptId: tesseract.attemptId,
      engine: "tesseract",
      currentSnapshot: false,
    });
  });

  it("exportYolo が正規化ラベル txt を出力し item-* は items クラスに寄せる", () => {
    const ds = new TrainingDataset(join(root, "ds"));
    ds.append(sampleRecord("r1"));
    const out = join(root, "out");
    const n = ds.exportYolo(out);
    expect(n).toBe(1);

    const label = readFileSync(join(out, "labels", "r1.txt"), "utf8").trim().split("\n");
    expect(label).toHaveLength(3);
    // payee = class 0, cx=(100+200)/1000=0.3, cy=(50+30)/2000=0.04, w=0.4, h=0.03
    expect(label[0]).toBe("0 0.300000 0.040000 0.400000 0.030000");
    // total = class 3
    expect(label[1]!.startsWith("3 ")).toBe(true);
    // item-0 → items = class 2
    expect(label[2]!.startsWith("2 ")).toBe(true);

    const classes = readFileSync(join(out, "classes.txt"), "utf8").trim().split("\n");
    expect(classes).toEqual(["payee", "date", "items", "total", "other"]);
  });
});
