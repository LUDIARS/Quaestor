/**
 * bench-report.json の読み書き。
 *
 * ラベルごとの最新結果を 1 ファイルに持つ (ラベル単位で上書き、走らせなかったラベルは残す)。
 * 世代ごとの推移は GaStore の evolution.jsonl が持つので、ここは「今どうか」だけ。
 *
 * @implements SPEC-OCR-GA-EVAL-003 (spec/feature/ocr-ga-evaluation.md)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BenchReport } from "./types.js";

export const BENCH_REPORT_FILE = "bench-report.json";

export function readBenchReport(path: string): BenchReport | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BenchReport>;
    if (!Array.isArray(parsed.labels)) return null;
    return {
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
      sidecarUrl: typeof parsed.sidecarUrl === "string" ? parsed.sidecarUrl : "",
      device: typeof parsed.device === "string" ? parsed.device : null,
      labels: parsed.labels,
    };
  } catch {
    return null; // 壊れた report は捨てて今回の結果で作り直す (観測用ファイル)
  }
}

/** 今回走らせたラベルで上書きし、走らせなかったラベルの前回結果は残す */
export function mergeBenchReport(prev: BenchReport | null, next: BenchReport): BenchReport {
  const byLabel = new Map<string, BenchReport["labels"][number]>();
  for (const l of prev?.labels ?? []) byLabel.set(l.label, l);
  for (const l of next.labels) byLabel.set(l.label, l);
  return {
    ts: next.ts,
    sidecarUrl: next.sidecarUrl,
    device: next.device,
    labels: [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function writeBenchReport(path: string, report: BenchReport): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", "utf8");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* failed atomic-write cleanup */ }
    }
  }
}
